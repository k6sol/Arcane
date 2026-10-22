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
const claudePreferenceModel = value => {
  if (value === null) return null;
  const model = workspacePreferenceText(value, 256);
  if (!model.length || model.trim() !== model || /[\x00-\x1f\x7f]/.test(model)) workspacePreferenceError();
  return model;
};
const workspacePreferenceSnapshot = (value, claude = false) => {
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
      draft: workspacePreferenceText(row.draft, 128 * 1024), modelId: claude ? claudePreferenceModel(row.modelId) : workspacePreferenceId(row.modelId, 256), effort: workspacePreferenceId(row.effort, 64),
      tool: row.tool, previewOpen: row.previewOpen, ...(flagged ? { workflowDraft: row.workflowDraft } : {}) });
  }
  const activeTabId = workspacePreferenceId(value.activeTabId, 128);
  if (activeTabId !== null && !ids.has(activeTabId)) workspacePreferenceError();
  const result = { version: 1, projectPath, provider: value.provider, tabs, activeTabId };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 512 * 1024) workspacePreferenceError();
  return result;
};
const workspacePreferenceInvoke = async (action, args, record = 'workspace') => {
  try {
    let input;
    if (action === 'read') { if (args.length) workspacePreferenceError(); }
    else { if (args.length !== 1) workspacePreferenceError(); input = workspacePreferenceSnapshot(args[0], record === 'claude');
      if (record === 'claude' && (input.provider !== 'claude' || input.tabs.some(row => row.provider !== 'claude' || row.sessionId !== null || row.tool !== 'all' || row.previewOpen !== false || Object.hasOwn(row, 'workflowDraft')))) workspacePreferenceError();
    }
    const value = await ipcRenderer.invoke((record === 'claude' ? 'arcane:claude-preferences-' : 'arcane:workspace-preferences-') + action, ...(input ? [input] : []));
    if (action === 'read') {
      workspacePreferenceFields(value, record === 'claude' ? ['available', 'projectPath', 'preferences'] : ['available', 'preferences']);
      if (typeof value.available !== 'boolean' || (!value.available && value.preferences !== null)) workspacePreferenceError();
      if (record === 'claude') {
        if (value.available ? typeof value.projectPath !== 'string' || !value.projectPath.length : value.projectPath !== null) workspacePreferenceError();
        const preferences = value.preferences === null ? null : workspacePreferenceSnapshot(value.preferences, true);
        if (preferences && (preferences.projectPath !== value.projectPath || preferences.provider !== 'claude' || preferences.tabs.some(row => row.provider !== 'claude' || row.sessionId !== null || row.tool !== 'all' || row.previewOpen !== false || Object.hasOwn(row, 'workflowDraft')))) workspacePreferenceError();
        return { available: value.available, projectPath: value.available ? workspacePreferenceText(value.projectPath, 4096) : null, preferences };
      }
      return { available: value.available, preferences: value.preferences === null ? null : workspacePreferenceSnapshot(value.preferences) };
    }
    workspacePreferenceFields(value, ['saved']); if (value.saved !== true) workspacePreferenceError();
    return { saved: true };
  } catch { workspacePreferenceError(); }
};
function librarySnapshot(value, scope) {
  const expanded=!!value&&typeof value==='object'&&Object.hasOwn(value,'expandedFolderIds');
  workspacePreferenceFields(value, ['version','projectPath','activeId','folders','conversations',...(expanded?['expandedFolderIds']:[])]);
  const projectPath=workspacePreferenceText(value.projectPath,4096);
  const array=(v,max)=>{if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype||v.length>max||Reflect.ownKeys(v).length!==v.length+1)workspacePreferenceError();return Array.from({length:v.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))workspacePreferenceError();return d.value;});};
  const singleLine=(v,max)=>{const s=workspacePreferenceText(v,max);if(/[\x00-\x1f\x7f]/.test(s))workspacePreferenceError();return s;};
  if(value.version!==1||projectPath!==scope.projectPath)workspacePreferenceError();
  const folderIds=new Set(),conversationIds=new Set(),nativeIds=new Set();let count=0;
  const folders=array(value.folders,64).map(v=>{const f=workspacePreferenceFields(v,['id','name']),id=workspacePreferenceText(f.id,256,true),name=singleLine(f.name,160);if(!name.trim()||folderIds.has(id))workspacePreferenceError();folderIds.add(id);return{id,name};});
  const conversations=array(value.conversations,256).map(v=>{
    const c=workspacePreferenceFields(v,['id','title','folderId','bindings','messages']),id=workspacePreferenceText(c.id,256,true),title=singleLine(c.title,512),folderId=workspacePreferenceId(c.folderId,256);
    if(conversationIds.has(id)||folderId!==null&&!folderIds.has(folderId))workspacePreferenceError();conversationIds.add(id);
    const providers=new Map();
    const bindings=array(c.bindings,3).map(v=>{const b=workspacePreferenceFields(v,['provider','conversationId','sessionId']),provider=b.provider,conversationId=workspacePreferenceText(b.conversationId,256,true),sessionId=workspacePreferenceId(b.sessionId,256);if(!['codex','claude','arcane'].includes(provider)||providers.has(provider))workspacePreferenceError();const key=JSON.stringify([provider,conversationId]);if(nativeIds.has(key))workspacePreferenceError();nativeIds.add(key);providers.set(provider,conversationId);return{provider,conversationId,sessionId};});
    const seen=new Set();
    const messages=array(c.messages,1024).map(v=>{const m=workspacePreferenceFields(v,['provider','conversationId','id','role','text','at','model']),provider=m.provider,conversationId=workspacePreferenceText(m.conversationId,256,true),id=workspacePreferenceText(m.id,512),role=m.role,body=workspacePreferenceText(m.text,128*1024),at=m.at,model=m.model===null?null:workspacePreferenceText(m.model,256);if(!id||providers.get(provider)!==conversationId||!['user','assistant','error'].includes(role)||!(at===null||typeof at==='string'&&at.length<=40&&Number.isFinite(Date.parse(at))))workspacePreferenceError();const key=JSON.stringify([provider,conversationId,id]);if(seen.has(key))workspacePreferenceError();seen.add(key);count++;return{provider,conversationId,id,role,text:body,at,model};});
    return{id,title,folderId,bindings,messages};
  });
  const activeId=workspacePreferenceId(value.activeId,256),result={version:1,projectPath,activeId,folders,conversations};
  // Optional presentation field: the open sidebar folders (unique, existing, omitted when empty).
  if(expanded){const open=array(value.expandedFolderIds,64).map(id=>workspacePreferenceText(id,256,true));if(!open.length||new Set(open).size!==open.length||open.some(id=>!folderIds.has(id)))workspacePreferenceError();result.expandedFolderIds=open;}
  if(activeId!==null&&!conversationIds.has(activeId)||count>1024||new TextEncoder().encode(JSON.stringify(result)).byteLength>480*1024)workspacePreferenceError();return result;
}

// Queue records contain unsubmitted text and advisory identifiers, never native execution authority.
function chatQueueSnapshot(value, scope, provider) {
  workspacePreferenceFields(value,['version','projectPath','provider','rows']);
  const projectPath=workspacePreferenceText(value.projectPath,4096);
  if(!projectPath.trim()||projectPath!==scope.projectPath||value.version!==1||value.provider!==provider)workspacePreferenceError();
  const list=value.rows;
  if(!Array.isArray(list)||Object.getPrototypeOf(list)!==Array.prototype||list.length>64||Reflect.ownKeys(list).length!==list.length+1)workspacePreferenceError();
  const ids=new Set(),counts=new Map(),rows=[];
  const uuid=v=>v===null?null:typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)?v:workspacePreferenceError();
  for(let i=0;i<list.length;i++){
    const d=Object.getOwnPropertyDescriptor(list,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))workspacePreferenceError();
    const r=workspacePreferenceFields(d.value,['id','localId','conversationId','sessionId','text','modelId','effort','connectionId','requestId','createdAt','state','attachmentState']);
    if(!Number.isSafeInteger(r.id)||r.id<1||r.id>2147483647||ids.has(r.id))workspacePreferenceError();ids.add(r.id);
    const localId=workspacePreferenceText(r.localId,128,true),conversationId=workspacePreferenceId(r.conversationId,256),sessionId=workspacePreferenceId(r.sessionId,256),body=workspacePreferenceText(r.text,128*1024),modelId=claudePreferenceModel(r.modelId),effort=workspacePreferenceId(r.effort,64),connectionId=uuid(r.connectionId),requestId=uuid(r.requestId),createdAt=workspacePreferenceText(r.createdAt,40);
    if(!body.trim()||!Number.isFinite(Date.parse(createdAt))||!['pending','unknown','rejected'].includes(r.state)||!['none','missing'].includes(r.attachmentState))workspacePreferenceError();
    const key=JSON.stringify([conversationId===null?localId:conversationId,sessionId]),count=(counts.get(key)??0)+1;if(count>5)workspacePreferenceError();counts.set(key,count);
    rows.push({id:r.id,localId,conversationId,sessionId,text:body,modelId,effort,connectionId,requestId,createdAt,state:r.state,attachmentState:r.attachmentState});
  }
  const result={version:1,projectPath,provider,rows};if(new TextEncoder().encode(JSON.stringify(result)).byteLength>1024*1024)workspacePreferenceError();return result;
}

const chatQueueInvoke=async(action,args)=>{
  try{
    if(args.length!==1)workspacePreferenceError();
    if(action==='save')workspacePreferenceFields(args[0],['version','projectPath','provider','rows']);
    const provider=action==='read'?args[0]:args[0].provider;if(provider!=='codex'&&provider!=='claude')workspacePreferenceError();
    const input=action==='save'?chatQueueSnapshot(args[0],{projectPath:args[0]?.projectPath},provider):null;
    const reply=await ipcRenderer.invoke('arcane:chat-queue-'+provider+'-'+action,...(input?[input]:[]));
    if(action==='save'){workspacePreferenceFields(reply,['saved']);if(reply.saved!==true)workspacePreferenceError();return{saved:true};}
    workspacePreferenceFields(reply,['available','projectPath','preferences']);
    if(typeof reply.available!=='boolean'||(reply.available?typeof reply.projectPath!=='string'||!reply.projectPath:reply.projectPath!==null||reply.preferences!==null))workspacePreferenceError();
    const snapshot=reply.preferences===null?null:chatQueueSnapshot(reply.preferences,{projectPath:reply.projectPath},provider);
    return{available:reply.available,projectPath:reply.projectPath,rows:snapshot?.rows??[]};
  }catch{workspacePreferenceError();}
};
const chatQueue=Object.freeze({version:1,read:(...args)=>chatQueueInvoke('read',args),save:(...args)=>chatQueueInvoke('save',args)});

const conversationLibraryInvoke = async (action,args) => {
  try {
    if(action==='read'?args.length!==0:args.length!==1)workspacePreferenceError();
    const input=action==='save'?librarySnapshot(args[0],{projectPath:args[0]?.projectPath}):null;
    const reply=await ipcRenderer.invoke('arcane:conversation-library-'+action,...(input?[input]:[]));
    if(action==='read'){
      workspacePreferenceFields(reply,['available','projectPath','preferences']);
      if(typeof reply.available!=='boolean'||(reply.available?typeof reply.projectPath!=='string'||!reply.projectPath:reply.projectPath!==null||reply.preferences!==null))workspacePreferenceError();
      return {available:reply.available,projectPath:reply.projectPath,preferences:reply.preferences===null?null:librarySnapshot(reply.preferences,{projectPath:reply.projectPath})};
    }
    workspacePreferenceFields(reply,['saved']);if(reply.saved!==true)workspacePreferenceError();return{saved:true};
  }catch{workspacePreferenceError();}
};
const conversationLibrary=Object.freeze({version:1,read:(...args)=>conversationLibraryInvoke('read',args),save:(...args)=>conversationLibraryInvoke('save',args)});

const workspacePreferences = Object.freeze({ version: 1,
  read: (...args) => workspacePreferenceInvoke('read', args), save: (...args) => workspacePreferenceInvoke('save', args),
});
const claudePreferences = Object.freeze({ version: 1,
  read: (...args) => workspacePreferenceInvoke('read', args, 'claude'), save: (...args) => workspacePreferenceInvoke('save', args, 'claude'),
});
const toolDraftSnapshot = value => {
  workspacePreferenceFields(value, ['version', 'projectPath', 'drafts']);
  const projectPath = workspacePreferenceText(value.projectPath, 4096);
  if (value.version !== 1 || !Array.isArray(value.drafts) || Object.getPrototypeOf(value.drafts) !== Array.prototype ||
      value.drafts.length > 16 || Reflect.ownKeys(value.drafts).length !== value.drafts.length + 1) workspacePreferenceError();
  const drafts = [], ids = new Set(), contexts = new Set();
  for (let i = 0; i < value.drafts.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.drafts, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) workspacePreferenceError();
    const row = workspacePreferenceFields(descriptor.value, ['id', 'kind', 'title', 'context', 'baseline', 'text']);
    if (!['project-memory', 'script-source'].includes(row.kind)) workspacePreferenceError();
    const id = workspacePreferenceText(row.id, 128, true), title = workspacePreferenceText(row.title, 512), context = workspacePreferenceText(row.context, 4096);
    const limit = row.kind === 'project-memory' ? 16 * 1024 : 100 * 1024;
    if (!context || /[\x00-\x1f\x7f]/.test(title) || row.kind === 'project-memory' && context !== 'project-memory' ||
        ids.has(id) || contexts.has(row.kind + ':' + context)) workspacePreferenceError();
    ids.add(id); contexts.add(row.kind + ':' + context);
    drafts.push({ id, kind: row.kind, title, context, baseline: row.baseline === null ? null : workspacePreferenceText(row.baseline, limit), text: workspacePreferenceText(row.text, limit) });
  }
  const result = { version: 1, projectPath, drafts };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 511 * 1024) workspacePreferenceError();
  return result;
};
const toolDraftInvoke = async (action, args) => {
  try {
    if (action === 'read' ? args.length !== 0 : args.length !== 1) workspacePreferenceError();
    const input = action === 'save' ? toolDraftSnapshot(args[0]) : null;
    const value = await ipcRenderer.invoke('arcane:tool-drafts-' + action, ...(input ? [input] : []));
    if (action === 'read') {
      workspacePreferenceFields(value, ['available', 'projectPath', 'preferences']);
      if (typeof value.available !== 'boolean' || (value.available ? typeof value.projectPath !== 'string' || !value.projectPath.length : value.projectPath !== null || value.preferences !== null)) workspacePreferenceError();
      const preferences = value.preferences === null ? null : toolDraftSnapshot(value.preferences);
      if (preferences && preferences.projectPath !== value.projectPath) workspacePreferenceError();
      return { available: value.available, projectPath: value.available ? workspacePreferenceText(value.projectPath, 4096) : null, preferences };
    }
    workspacePreferenceFields(value, ['saved']); if (value.saved !== true) workspacePreferenceError();
    return { saved: true };
  } catch { workspacePreferenceError(); }
};
const toolDrafts = Object.freeze({ version: 1,
  read: (...args) => toolDraftInvoke('read', args), save: (...args) => toolDraftInvoke('save', args),
});
const welcomeTourInvoke = async (action, args) => {
  try {
    if (action === 'read') { if (args.length) workspacePreferenceError(); }
    else if (args.length !== 1 || !['finished', 'skipped', 'shown'].includes(workspacePreferenceFields(args[0], ['how']).how)) workspacePreferenceError();
    const value = await ipcRenderer.invoke('arcane:welcome-tour-' + action, ...(action === 'read' ? [] : [{ how: args[0].how }]));
    if (action === 'read') {
      workspacePreferenceFields(value, ['available', 'seen']);
      if (typeof value.available !== 'boolean' || typeof value.seen !== 'boolean' || !value.available && value.seen) workspacePreferenceError();
      return { available: value.available, seen: value.seen };
    }
    workspacePreferenceFields(value, ['saved']); if (value.saved !== true) workspacePreferenceError();
    return { saved: true };
  } catch { workspacePreferenceError(); }
};
const welcomeTour = Object.freeze({ version: 1,
  read: (...args) => welcomeTourInvoke('read', args), dismiss: (...args) => welcomeTourInvoke('dismiss', args),
});
const checklistMemory = value => {
  workspacePreferenceFields(value, ['version', 'completed', 'dismissed']);
  if (value.version !== 1 || typeof value.completed !== 'boolean' || typeof value.dismissed !== 'boolean') workspacePreferenceError();
  return { version: 1, completed: value.completed, dismissed: value.dismissed };
};
const setupChecklistInvoke = async (action, args) => {
  try {
    if (action === 'read' ? args.length !== 0 : args.length !== 1) workspacePreferenceError();
    const input = action === 'save' ? checklistMemory(args[0]) : null;
    const value = await ipcRenderer.invoke('arcane:setup-checklist-' + action, ...(input ? [input] : []));
    if (action === 'read') {
      workspacePreferenceFields(value, ['available', 'memory']);
      if (typeof value.available !== 'boolean' || !value.available && value.memory !== null) workspacePreferenceError();
      return { available: value.available, memory: value.memory === null ? null : checklistMemory(value.memory) };
    }
    workspacePreferenceFields(value, ['saved']); if (value.saved !== true) workspacePreferenceError();
    return { saved: true };
  } catch { workspacePreferenceError(); }
};
const setupChecklist = Object.freeze({ version: 1,
  read: (...args) => setupChecklistInvoke('read', args), save: (...args) => setupChecklistInvoke('save', args),
});
// In-app Claude chat: exact argument envelopes out, plain bounded copies back. Only fixed host messages pass through.
const CLAUDE_CHAT_ERRORS = ['Claude chat is unavailable.', 'Another Claude chat reply is still running in this conversation.',
  'Too many Claude chat replies are running. Wait for one to finish.', 'This conversation no longer exists.', 'Message is empty or too long.',
  'This message can no longer be edited.', 'Attached images must be at most 4 PNG references within 512 KiB in total.'];
// Optional PNG references on send: 1..4 exact {name, dataUrl} records with a bounded base64 PNG data URL (the main process
// decodes and checks the PNG signature and the 512 KiB total again).
const CLAUDE_CHAT_IMAGE_PREFIX = 'data:image/png;base64,';
const claudeChatImages = value => {
  const bad = () => { throw new Error(CLAUDE_CHAT_ERRORS[6]); };
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 4 || Reflect.ownKeys(value).length !== value.length + 1) bad();
  let chars = 0;
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index)), item = field && Object.hasOwn(field, 'value') ? field.value : null;
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype || Reflect.ownKeys(item).length !== 2) bad();
    for (const key of ['name', 'dataUrl']) { const d = Object.getOwnPropertyDescriptor(item, key); if (!d?.enumerable || !Object.hasOwn(d, 'value') || typeof d.value !== 'string') bad(); }
    const { name, dataUrl } = item;
    if (!name || name.length > 128 || name.trim() !== name || !/\.(?:png|jpe?g|webp)$/i.test(name) || /[\u0000-\u001f\u007f-\u009f\\/<>:"|?*]/.test(name)) bad();
    chars += dataUrl.length;
    if (!dataUrl.startsWith(CLAUDE_CHAT_IMAGE_PREFIX) || chars > 4 * CLAUDE_CHAT_IMAGE_PREFIX.length + Math.ceil(524288 / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(dataUrl.slice(CLAUDE_CHAT_IMAGE_PREFIX.length))) bad();
    return { name, dataUrl };
  });
};
// The engine's one fixed usage-limit message (claude-chat.cjs MESSAGES.usageLimit); done events may carry it with a reset time.
const CLAUDE_CHAT_USAGE_LIMIT = 'Claude usage limit reached. This message was not answered; try again after the limit resets.';
const claudeChatUnavailable = () => { throw new Error(CLAUDE_CHAT_ERRORS[0]); };
const claudeChatId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const claudeChatChoice = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const claudeChatTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
const claudeChatText = (value, max) => typeof value === 'string' && value.length <= max;
const claudeChatList = (value, max) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max;
// A live tool event may carry one display image (a Studio viewport capture from Arcane's own tools): a PNG or JPEG data:
// URL of canonical base64, at most 1.5 MiB decoded (claude-chat.cjs toolResultImage). Saved history never carries one.
const CLAUDE_CHAT_TOOL_IMAGE = /^data:image\/(?:png|jpeg);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CLAUDE_CHAT_TOOL_IMAGE_CHARS = 'data:image/jpeg;base64,'.length + Math.ceil(1536 * 1024 / 3) * 4;
const claudeChatMessage = (value, live = false) => {
  if (!value || typeof value !== 'object' || !claudeChatId(value.id) || !['user', 'assistant', 'tool', 'error'].includes(value.role) ||
      !claudeChatText(value.text, value.role==='user'?101024:65536) || !claudeChatTime(value.at)) claudeChatUnavailable();
  const out = { id: value.id, role: value.role, text: value.text, at: value.at };
  if(value.delivery!==undefined){
    const d=value.delivery,keys=['model','effort','turnId','startedAt','finishedAt','state','error','contextIncluded','transmittedBytes'];
    if(!d||Object.getPrototypeOf(d)!==Object.prototype||Reflect.ownKeys(d).length!==keys.length||keys.some(k=>{const p=Object.getOwnPropertyDescriptor(d,k);return !p?.enumerable||!Object.hasOwn(p,'value');})||
      !claudeChatText(d.model,128)||!d.model||!claudeChatText(d.effort,64)||!d.effort||!claudeChatId(d.turnId)||!claudeChatTime(d.startedAt)||!(d.finishedAt===null||claudeChatTime(d.finishedAt))||
      !['sending','accepted','completed','failed','stopped'].includes(d.state)||!(d.error===null||claudeChatText(d.error,2048))||typeof d.contextIncluded!=='boolean'||!Number.isSafeInteger(d.transmittedBytes)||d.transmittedBytes<0||d.transmittedBytes>2000000)claudeChatUnavailable();
    out.delivery=Object.fromEntries(keys.map(k=>[k,d[k]]));
  }
  // A user message sent into a running reply (steer) carries steered: true; nothing else may.
  if (value.steered !== undefined) { if (value.steered !== true || value.role !== 'user') claudeChatUnavailable(); out.steered = true; }
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
    // Anything else in that field is dropped; the status update itself still reaches the renderer.
    const image = live ? value.tool.image : undefined;
    if (out.tool.status === 'finished' && typeof image === 'string' && image.length <= CLAUDE_CHAT_TOOL_IMAGE_CHARS && CLAUDE_CHAT_TOOL_IMAGE.test(image)) out.tool.image = image;
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
  if (action === 'steer') {
    if (!claudeChatId(value.messageId)) claudeChatUnavailable();
    return { messageId: value.messageId };
  }
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
  if (action === 'rewind') {
    if (!claudeChatId(value.conversationId) || !Number.isSafeInteger(value.kept) || value.kept < 0 || value.kept > 2000) claudeChatUnavailable();
    return { conversationId: value.conversationId, kept: value.kept };
  }
  if (!claudeChatId(value.turnId) || !claudeChatId(value.conversationId)) claudeChatUnavailable();
  // The saved id of the sent user message (lets the renderer offer Edit on it); older engines omit it.
  if (value.messageId !== undefined && !claudeChatId(value.messageId)) claudeChatUnavailable();
  return { turnId: value.turnId, conversationId: value.conversationId, ...(value.messageId === undefined ? {} : { messageId: value.messageId }) };
};
const claudeChatInvoke = async (action, args) => {
  let input;
  if (action === 'status' || action === 'list') { if (args.length) claudeChatUnavailable(); }
  else if (action === 'send') {
    const value = args[0];
    const keys = ['conversationId', 'text', 'model', 'effort'];
    if (value && typeof value === 'object' && Object.hasOwn(value, 'images')) keys.push('images');
    if (value && typeof value === 'object' && Object.hasOwn(value, 'displayText')) keys.push('displayText');
    // The composer's Playtest switch, when mounted: a plain boolean the engine turns into a short system note.
    if (value && typeof value === 'object' && Object.hasOwn(value, 'playtest')) keys.push('playtest');
    if (args.length !== 1 || !value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) claudeChatUnavailable();
    for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d?.enumerable || !Object.hasOwn(d, 'value')) claudeChatUnavailable(); }
    if (!(value.conversationId === null || claudeChatId(value.conversationId)) || !claudeChatChoice(value.model) || !claudeChatChoice(value.effort)) claudeChatUnavailable();
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 100000) throw new Error(CLAUDE_CHAT_ERRORS[4]);
    if(keys.includes('displayText')&&(typeof value.displayText!=='string'||!value.displayText.trim()||!value.displayText.isWellFormed()||value.displayText.length>100000))claudeChatUnavailable();
    if (keys.includes('playtest') && typeof value.playtest !== 'boolean') claudeChatUnavailable();
    input = { conversationId: value.conversationId, text: value.text, model: value.model, effort: value.effort, ...(keys.includes('images') ? { images: claudeChatImages(value.images) } : {}),
      ...(keys.includes('playtest') ? { playtest: value.playtest } : {}),...(keys.includes('displayText')?{displayText:value.displayText}:{}) };
  } else if (action === 'rewind') {
    const value = args[0];
    if (args.length !== 1 || !value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2) claudeChatUnavailable();
    for (const key of ['conversationId', 'messageId']) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d?.enumerable || !Object.hasOwn(d, 'value') || !claudeChatId(d.value)) claudeChatUnavailable(); }
    input = { conversationId: value.conversationId, messageId: value.messageId };
  } else if (action === 'steer') {
    // Guidance for the running reply: its turn id and plain text only (attachments wait for the next message).
    const value = args[0];
    if (args.length !== 1 || !value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2) claudeChatUnavailable();
    for (const key of ['turnId', 'text']) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d?.enumerable || !Object.hasOwn(d, 'value')) claudeChatUnavailable(); }
    if (!claudeChatId(value.turnId)) claudeChatUnavailable();
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 100000) throw new Error(CLAUDE_CHAT_ERRORS[4]);
    input = { turnId: value.turnId, text: value.text };
  } else { if (args.length !== 1 || !claudeChatId(args[0])) claudeChatUnavailable(); input = args[0]; }
  let value;
  try { value = await ipcRenderer.invoke('arcane:claude-chat-' + action, ...(input === undefined ? [] : [input])); }
  catch (error) { const text = String(error?.message ?? ''); throw new Error(CLAUDE_CHAT_ERRORS.find(known => text.endsWith(known)) ?? CLAUDE_CHAT_ERRORS[0]); }
  if (action === 'stop' || action === 'remove') { if (typeof value !== 'boolean') claudeChatUnavailable(); return value; }
  // false: the reply can no longer take guidance (the renderer queues the message instead).
  if (action === 'steer' && value === false) return false;
  return claudeChatReply(action, value);
};
const claudeChatEvent = value => {
  if (!value || typeof value !== 'object' || !claudeChatId(value.turnId) || !claudeChatId(value.conversationId)) return null;
  const base = { turnId: value.turnId, conversationId: value.conversationId };
  try {
    if (value.type === 'delta') return claudeChatText(value.text, 65536) ? { ...base, type: 'delta', text: value.text } : null;
    if (value.type === 'message' || value.type === 'tool') return { ...base, type: value.type, message: claudeChatMessage(value.message, value.type === 'tool') };
    if (value.type === 'done') {
      const u = value.usage, number = n => Number.isSafeInteger(n) && n >= 0;
      if (typeof value.ok !== 'boolean' || !(value.error === null || claudeChatText(value.error, 512)) ||
          !(u === null || u && typeof u === 'object' && number(u.inputTokens) && number(u.outputTokens) && (u.costUsd === null || typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0))) return null;
      // A usage limit is only the fixed engine message plus an optional bounded reset time (Unix seconds) and window.
      const l = value.usageLimit ?? null;
      if (!(l === null || value.ok === false && value.error === CLAUDE_CHAT_USAGE_LIMIT && l && typeof l === 'object' &&
          (l.resetsAt === null || Number.isSafeInteger(l.resetsAt) && l.resetsAt >= 1e9 && l.resetsAt < 1e11))) return null;
      return { ...base, type: 'done', ok: value.ok, error: value.error, usage: u === null ? null : { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd },
        // The limit window ('session' or 'weekly') rides along only as one of those two fixed words.
        usageLimit: l === null ? null : l.window === 'session' || l.window === 'weekly' ? { resetsAt: l.resetsAt, window: l.window } : { resetsAt: l.resetsAt } };
    }
  } catch { return null; }
  return null;
};
const claudeChat = Object.freeze({ version: 1,
  status: (...args) => claudeChatInvoke('status', args), list: (...args) => claudeChatInvoke('list', args),
  history: (...args) => claudeChatInvoke('history', args), send: (...args) => claudeChatInvoke('send', args),
  steer: (...args) => claudeChatInvoke('steer', args), rewind: (...args) => claudeChatInvoke('rewind', args),
  stop: (...args) => claudeChatInvoke('stop', args), remove: (...args) => claudeChatInvoke('remove', args),
  onEvent: listener => {
    if (typeof listener !== 'function') claudeChatUnavailable();
    const wrapped = (_event, payload) => { const event = claudeChatEvent(payload); if (event) { try { listener(event); } catch { /* renderer listener errors stay in the renderer */ } } };
    ipcRenderer.on('arcane:claude-chat-event', wrapped);
    let active = true;
    return () => { if (active) { active = false; ipcRenderer.removeListener('arcane:claude-chat-event', wrapped); } };
  },
});
// In-app Arcane chat (Arcane Credits, arcane-chat.cjs): the Claude chat bridge's shapes, text only (no images), gateway
// model ids, and a status with the account's models (credit prices per million tokens) and balance. The account token,
// gateway URL and project credential never cross this bridge.
const ARCANE_CHAT_ERRORS = ['Arcane chat is unavailable.', 'Another Arcane chat reply is still running in this conversation.',
  'Too many Arcane chat replies are running. Wait for one to finish.', 'This conversation no longer exists.', 'Message is empty or too long.',
  'This message can no longer be edited.', 'Arcane Credits chat sends text only. Remove the attached images, then send.'];
// The engine's one fixed out-of-credits message (arcane-chat.cjs MESSAGES.noCredits); only it may carry a usage limit.
const ARCANE_CHAT_NO_CREDITS = "You're out of Arcane Credits. This message was not answered; buy credits to continue.";
const arcaneChatUnavailable = () => { throw new Error(ARCANE_CHAT_ERRORS[0]); };
const arcaneChatModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(value);
const arcaneChatCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
const arcaneChatGuard = fn => { try { return fn(); } catch { return arcaneChatUnavailable(); } };
const arcaneChatReply = (action, value) => arcaneChatGuard(() => {
  if (!value || typeof value !== 'object') arcaneChatUnavailable();
  if (action === 'status') {
    if (typeof value.available !== 'boolean' || !['disabled', 'signed-out', 'error', 'ready'].includes(value.state) || !claudeChatList(value.models, 32) ||
        !claudeChatList(value.efforts, 4) || !value.efforts.every(claudeChatChoice) || !(value.message === null || claudeChatText(value.message, 512))) arcaneChatUnavailable();
    const models = value.models.map(m => {
      if (!m || typeof m !== 'object' || !arcaneChatModel(m.id) || !claudeChatText(m.label, 64) || !m.label) arcaneChatUnavailable();
      const p = m.pricing;
      if (!(p === null || p && typeof p === 'object' && arcaneChatCount(p.inputPerMTok) && arcaneChatCount(p.outputPerMTok))) arcaneChatUnavailable();
      return { id: m.id, label: m.label, pricing: p === null ? null : { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok } };
    });
    if (!(value.defaultModel === null || models.some(m => m.id === value.defaultModel))) arcaneChatUnavailable();
    const b = value.balance;
    if (!(b === null || b && typeof b === 'object' && arcaneChatCount(b.credits) && (b.actionsRemaining === null || arcaneChatCount(b.actionsRemaining)) &&
        (b.plan === null || claudeChatText(b.plan, 48)))) arcaneChatUnavailable();
    return { available: value.available, state: value.state, models, efforts: [...value.efforts], defaultModel: value.defaultModel,
      balance: b === null ? null : { credits: b.credits, actionsRemaining: b.actionsRemaining, plan: b.plan }, message: value.message };
  }
  if (action === 'list') {
    if (!claudeChatList(value.conversations, 200)) arcaneChatUnavailable();
    return { conversations: value.conversations.map(c => {
      if (!c || !claudeChatId(c.conversationId) || !claudeChatText(c.title, 200) || !claudeChatTime(c.updatedAt) || !arcaneChatModel(c.model) || !claudeChatChoice(c.effort)) arcaneChatUnavailable();
      return { conversationId: c.conversationId, title: c.title, updatedAt: c.updatedAt, model: c.model, effort: c.effort };
    }) };
  }
  if (action === 'history') {
    if (!claudeChatId(value.conversationId) || !claudeChatList(value.messages, 2000)) arcaneChatUnavailable();
    return { conversationId: value.conversationId, messages: value.messages.map(claudeChatMessage) };
  }
  if (action === 'rewind') {
    if (!claudeChatId(value.conversationId) || !Number.isSafeInteger(value.kept) || value.kept < 0 || value.kept > 2000) arcaneChatUnavailable();
    return { conversationId: value.conversationId, kept: value.kept };
  }
  if (!claudeChatId(value.turnId) || !claudeChatId(value.conversationId) || value.messageId !== undefined && !claudeChatId(value.messageId)) arcaneChatUnavailable();
  return { turnId: value.turnId, conversationId: value.conversationId, ...(value.messageId === undefined ? {} : { messageId: value.messageId }) };
});
const arcaneChatInvoke = async (action, args) => {
  let input;
  if (action === 'status' || action === 'list') { if (args.length) arcaneChatUnavailable(); }
  else if (action === 'send') {
    const value = args[0];
    if (value && typeof value === 'object' && Object.hasOwn(value, 'images')) throw new Error(ARCANE_CHAT_ERRORS[6]);
    const keys = ['conversationId', 'text', 'model', 'effort'];
    if (value && typeof value === 'object' && Object.hasOwn(value, 'displayText')) keys.push('displayText');
    if (value && typeof value === 'object' && Object.hasOwn(value, 'playtest')) keys.push('playtest');
    if (args.length !== 1 || !value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) arcaneChatUnavailable();
    for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d?.enumerable || !Object.hasOwn(d, 'value')) arcaneChatUnavailable(); }
    if (!(value.conversationId === null || claudeChatId(value.conversationId)) || !arcaneChatModel(value.model) || !claudeChatChoice(value.effort)) arcaneChatUnavailable();
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 100000) throw new Error(ARCANE_CHAT_ERRORS[4]);
    if(keys.includes('displayText')&&(typeof value.displayText!=='string'||!value.displayText.trim()||!value.displayText.isWellFormed()||value.displayText.length>100000))arcaneChatUnavailable();
    if (keys.includes('playtest') && typeof value.playtest !== 'boolean') arcaneChatUnavailable();
    input = { conversationId: value.conversationId, text: value.text, model: value.model, effort: value.effort, ...(keys.includes('playtest') ? { playtest: value.playtest } : {}),...(keys.includes('displayText')?{displayText:value.displayText}:{}) };
  } else if (action === 'rewind') {
    const value = args[0];
    if (args.length !== 1 || !value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2) arcaneChatUnavailable();
    for (const key of ['conversationId', 'messageId']) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d?.enumerable || !Object.hasOwn(d, 'value') || !claudeChatId(d.value)) arcaneChatUnavailable(); }
    input = { conversationId: value.conversationId, messageId: value.messageId };
  } else { if (args.length !== 1 || !claudeChatId(args[0])) arcaneChatUnavailable(); input = args[0]; }
  let value;
  try { value = await ipcRenderer.invoke('arcane:arcane-chat-' + action, ...(input === undefined ? [] : [input])); }
  catch (error) { const text = String(error?.message ?? ''); throw new Error(ARCANE_CHAT_ERRORS.find(known => text.endsWith(known)) ?? ARCANE_CHAT_ERRORS[0]); }
  if (action === 'stop' || action === 'remove') { if (typeof value !== 'boolean') arcaneChatUnavailable(); return value; }
  return arcaneChatReply(action, value);
};
const arcaneChatEvent = value => {
  if (!value || typeof value !== 'object' || !claudeChatId(value.turnId) || !claudeChatId(value.conversationId)) return null;
  const base = { turnId: value.turnId, conversationId: value.conversationId };
  try {
    if (value.type === 'delta') return claudeChatText(value.text, 65536) ? { ...base, type: 'delta', text: value.text } : null;
    if (value.type === 'message' || value.type === 'tool') return { ...base, type: value.type, message: claudeChatMessage(value.message, value.type === 'tool') };
    if (value.type === 'done') {
      const u = value.usage;
      if (typeof value.ok !== 'boolean' || !(value.error === null || claudeChatText(value.error, 512)) ||
          !(u === null || u && typeof u === 'object' && arcaneChatCount(u.inputTokens) && arcaneChatCount(u.outputTokens) && u.costUsd === null && (u.credits === null || arcaneChatCount(u.credits)))) return null;
      // A usage limit here means only "out of credits": the fixed engine message, never a reset time.
      const l = value.usageLimit ?? null;
      if (!(l === null || value.ok === false && value.error === ARCANE_CHAT_NO_CREDITS && l && typeof l === 'object' && l.resetsAt === null)) return null;
      return { ...base, type: 'done', ok: value.ok, error: value.error, usage: u === null ? null : { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: null, credits: u.credits },
        usageLimit: l === null ? null : { resetsAt: null } };
    }
  } catch { return null; }
  return null;
};
const arcaneChat = Object.freeze({ version: 1,
  status: (...args) => arcaneChatInvoke('status', args), list: (...args) => arcaneChatInvoke('list', args),
  history: (...args) => arcaneChatInvoke('history', args), send: (...args) => arcaneChatInvoke('send', args),
  rewind: (...args) => arcaneChatInvoke('rewind', args),
  stop: (...args) => arcaneChatInvoke('stop', args), remove: (...args) => arcaneChatInvoke('remove', args),
  onEvent: listener => {
    if (typeof listener !== 'function') arcaneChatUnavailable();
    const wrapped = (_event, payload) => { const event = arcaneChatEvent(payload); if (event) { try { listener(event); } catch { /* renderer listener errors stay in the renderer */ } } };
    ipcRenderer.on('arcane:arcane-chat-event', wrapped);
    let active = true;
    return () => { if (active) { active = false; ipcRenderer.removeListener('arcane:arcane-chat-event', wrapped); } };
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
  'A plugin install is already running.', 'The plugin folder changed during install. Nothing was overwritten; try again.',
  'Roblox Studio or another program is using the plugin file. Close Roblox Studio, then try again.',
  'Roblox Studio is not set up for this Windows user yet. Install Roblox Studio and open it once, then try again.',
  'Arcane updated the Studio plugin automatically. Restart Roblox Studio to load it.',
  'Arcane will update the Studio plugin automatically.', 'Arcane will ask before updating the Studio plugin.',
  'The plugin update preference could not be saved.'];
const studioPluginInvoke = async (action, args) => {
  if (args.length) throw new Error(STUDIO_PLUGIN_UNAVAILABLE);
  let value;
  try { value = await ipcRenderer.invoke('arcane:studio-plugin-' + action); }
  catch (error) { const text = String(error?.message ?? ''); throw new Error(STUDIO_PLUGIN_MESSAGES.find(known => text.endsWith(known)) ?? STUDIO_PLUGIN_UNAVAILABLE); }
  // The "update automatically" choice: one boolean and a fixed message.
  if (['preference', 'auto-on', 'auto-off'].includes(action)) {
    if (!value || typeof value !== 'object' || value.version !== 1 || typeof value.autoUpdate !== 'boolean' || !STUDIO_PLUGIN_MESSAGES.includes(value.message)) throw new Error(STUDIO_PLUGIN_UNAVAILABLE);
    return { version: 1, autoUpdate: value.autoUpdate, message: value.message };
  }
  const writes = action === 'install' || action === 'auto-update';
  if (!value || typeof value !== 'object' || value.version !== 1 || !['installed', 'outdated', 'missing', 'unavailable'].includes(value.state) ||
      !(value.pluginVersion === null || typeof value.pluginVersion === 'string' && /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/.test(value.pluginVersion)) ||
      !STUDIO_PLUGIN_MESSAGES.includes(value.message) || (writes && typeof value.changed !== 'boolean')) throw new Error(STUDIO_PLUGIN_UNAVAILABLE);
  return { version: 1, state: value.state, pluginVersion: value.pluginVersion, message: value.message, ...(writes ? { changed: value.changed } : {}) };
};
const studioPlugin = Object.freeze({ version: 1,
  status: (...args) => studioPluginInvoke('status', args), install: (...args) => studioPluginInvoke('install', args),
  autoUpdate: (...args) => studioPluginInvoke('auto-update', args), preference: (...args) => studioPluginInvoke('preference', args),
  enableAutoUpdate: (...args) => studioPluginInvoke('auto-on', args), disableAutoUpdate: (...args) => studioPluginInvoke('auto-off', args),
});
// Open project: the host shows its own native folder picker and switch confirmation. Nothing else crosses.
const workspaceProject = Object.freeze({ version: 1,
  open: async (...args) => {
    try { if (args.length) throw new Error(); const value = await ipcRenderer.invoke('arcane:project-open'); if (!value || value.requested !== true) throw new Error(); return { requested: true }; }
    catch { throw new Error('The project picker is unavailable.'); }
  },
});
// In-app dialogs: the host sends one bounded question at a time; the workspace renders it and answers with the request id
// and one button index (the host validates both again). attach() registers the single listener and tells the host it may
// stop using native message boxes for this document.
const DIALOG_UNAVAILABLE = 'In-app dialogs are unavailable.';
const dialogText = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value);
const dialogRequest = value => {
  if (!value || typeof value !== 'object' || value.version !== 1 || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id) ||
      !['none', 'info', 'question', 'warning', 'error'].includes(value.type) || !dialogText(value.title, 120) || !dialogText(value.message, 600) || !dialogText(value.detail, 4000) ||
      !Array.isArray(value.buttons) || value.buttons.length < 1 || value.buttons.length > 4 || !value.buttons.every(label => dialogText(label, 48) && label.length > 0)) return null;
  const index = n => Number.isSafeInteger(n) && n >= 0 && n < value.buttons.length;
  if (!index(value.defaultId) || !index(value.cancelId)) return null;
  return { id: value.id, type: value.type, title: value.title, message: value.message, detail: value.detail, buttons: [...value.buttons], defaultId: value.defaultId, cancelId: value.cancelId };
};
let dialogListener = null;
const dialogs = Object.freeze({ version: 1,
  attach: async listener => {
    if (typeof listener !== 'function' || dialogListener) throw new Error(DIALOG_UNAVAILABLE);
    dialogListener = (_event, payload) => { const request = dialogRequest(payload); if (request) { try { listener(request); } catch { /* renderer errors stay there */ } } };
    ipcRenderer.on('arcane:dialog-request', dialogListener);
    try { const value = await ipcRenderer.invoke('arcane:dialog-attach'); if (!value || value.attached !== true) throw new Error(); return { attached: true }; }
    catch { ipcRenderer.removeListener('arcane:dialog-request', dialogListener); dialogListener = null; throw new Error(DIALOG_UNAVAILABLE); }
  },
  reply: async (...args) => {
    const value = args[0];
    if (args.length !== 1 || !value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2 ||
        typeof value.id !== 'string' || !Number.isSafeInteger(value.response)) throw new Error(DIALOG_UNAVAILABLE);
    try { const out = await ipcRenderer.invoke('arcane:dialog-reply', { id: value.id, response: value.response }); return { accepted: out?.accepted === true }; }
    catch { throw new Error(DIALOG_UNAVAILABLE); }
  },
});
// Persistent per-project agent permissions (Settings > Permissions): two booleans, read and saved by the host.
const PERMISSIONS_UNAVAILABLE = 'Project permissions are unavailable.';
const permissionSettings = value => {
  if (!value || typeof value !== 'object' || typeof value.claudeTools !== 'boolean' || typeof value.codexAutoApprove !== 'boolean') throw new Error(PERMISSIONS_UNAVAILABLE);
  return { claudeTools: value.claudeTools, codexAutoApprove: value.codexAutoApprove };
};
const projectPermissions = Object.freeze({ version: 1,
  read: async (...args) => {
    try {
      if (args.length) throw new Error();
      const value = await ipcRenderer.invoke('arcane:project-permissions-read');
      if (!value || typeof value.available !== 'boolean') throw new Error();
      return { available: value.available, settings: permissionSettings(value.settings) };
    } catch { throw new Error(PERMISSIONS_UNAVAILABLE); }
  },
  save: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
      const keys = Reflect.ownKeys(value);
      if (!keys.length || keys.some(key => !['claudeTools', 'codexAutoApprove'].includes(key) || typeof value[key] !== 'boolean')) throw new Error();
      const out = await ipcRenderer.invoke('arcane:project-permissions-save', Object.fromEntries(keys.map(key => [key, value[key]])));
      // saved:false means the host's trusted confirmation for turning a switch on was declined; nothing changed.
      if (!out || typeof out.saved !== 'boolean') throw new Error();
      return { saved: out.saved, settings: permissionSettings(out.settings) };
    } catch { throw new Error(PERMISSIONS_UNAVAILABLE); }
  },
});
// Plans & credits checkout: one offer id out; the host owns the URL, allowlist and confirmation. Only fixed states and
// the host's fixed messages come back (billing.cjs).
const BILLING_UNAVAILABLE = 'Checkout is unavailable right now. Nothing was charged.';
const BILLING_MESSAGES = ["Checkout isn't connected yet", 'Checkout is connected.', 'Checkout opened in your browser', 'Checkout cancelled. Nothing was charged.',
  'That offer is unavailable. Nothing was charged.', 'A checkout question is already open.', BILLING_UNAVAILABLE];
const BILLING_STATES = ['not-connected', 'ready', 'opened', 'cancelled', 'unknown-offer', 'busy', 'unavailable'];
// Arcane account (gateway sign-in): no arguments out; fixed states and messages back. The token never reaches here.
const BILLING_ACCOUNT_STATES = ['unavailable', 'signed-out', 'signing-in', 'signed-in'];
const ACCOUNT_UNAVAILABLE = 'Arcane account sign-in is unavailable right now.';
const ACCOUNT_MESSAGES = ["Arcane Credits aren't connected yet", 'Finish signing in in your browser', 'Sign-in cancelled.', 'A sign-in is already in progress.',
  'Your Arcane account is connected.', 'Your Arcane account is disconnected.', ACCOUNT_UNAVAILABLE];
const ACCOUNT_STATES = ['not-connected', 'opened', 'cancelled', 'busy', 'signed-in', 'signed-out', 'unavailable'];
const billingReply = (value, withAccount) => {
  if (!value || typeof value !== 'object' || value.version !== 1 || !BILLING_STATES.includes(value.state) || !BILLING_MESSAGES.includes(value.message) ||
      (withAccount && !BILLING_ACCOUNT_STATES.includes(value.account))) throw new Error(BILLING_UNAVAILABLE);
  return { version: 1, state: value.state, message: value.message, ...(withAccount ? { account: value.account } : {}) };
};
const accountReply = value => {
  if (!value || typeof value !== 'object' || value.version !== 1 || !ACCOUNT_STATES.includes(value.state) || !ACCOUNT_MESSAGES.includes(value.message)) throw new Error(ACCOUNT_UNAVAILABLE);
  return { version: 1, state: value.state, message: value.message };
};
const billing = Object.freeze({ version: 1,
  status: async (...args) => {
    try { if (args.length) throw new Error(); return billingReply(await ipcRenderer.invoke('arcane:billing-status'), true); }
    catch { throw new Error(BILLING_UNAVAILABLE); }
  },
  openCheckout: async (...args) => {
    try {
      if (args.length !== 1 || typeof args[0] !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(args[0])) throw new Error();
      return billingReply(await ipcRenderer.invoke('arcane:billing-checkout', args[0]), false);
    } catch { throw new Error(BILLING_UNAVAILABLE); }
  },
  connectAccount: async (...args) => {
    try { if (args.length) throw new Error(); return accountReply(await ipcRenderer.invoke('arcane:billing-account-connect')); }
    catch { throw new Error(ACCOUNT_UNAVAILABLE); }
  },
  disconnectAccount: async (...args) => {
    try { if (args.length) throw new Error(); return accountReply(await ipcRenderer.invoke('arcane:billing-account-disconnect')); }
    catch { throw new Error(ACCOUNT_UNAVAILABLE); }
  },
});
// Build-done notifications: a fixed kind, a short plain body and an opaque target id out; clicks return only the target.
const NOTIFICATIONS_UNAVAILABLE = 'Notifications are unavailable.';
const notificationTarget = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
const notifications = Object.freeze({ version: 1,
  notify: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 3 ||
          !['finished', 'attention'].includes(value.kind) || typeof value.body !== 'string' || value.body.length > 480 || !notificationTarget(value.target)) throw new Error();
      const out = await ipcRenderer.invoke('arcane:notification-show', { kind: value.kind, body: value.body, target: value.target });
      return { shown: out?.shown === true };
    } catch { throw new Error(NOTIFICATIONS_UNAVAILABLE); }
  },
  onActivate: listener => {
    if (typeof listener !== 'function') throw new Error(NOTIFICATIONS_UNAVAILABLE);
    const wrapped = (_event, payload) => { if (payload && notificationTarget(payload.target)) { try { listener({ target: payload.target }); } catch { /* renderer errors stay there */ } } };
    ipcRenderer.on('arcane:notification-activate', wrapped);
    let active = true;
    return () => { if (active) { active = false; ipcRenderer.removeListener('arcane:notification-activate', wrapped); } };
  },
});
// Keep this mesh: one placed mesh id (transfer digest + Studio session) out after the person's click; the host confirms in its
// own trusted dialog and answers with a fixed state and a short message. Nothing else crosses.
const MESH_KEEP_UNAVAILABLE = 'Keep this mesh is unavailable.';
const meshKeep = Object.freeze({ version: 1,
  keep: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2 ||
          typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)) throw new Error();
      const out = await ipcRenderer.invoke('arcane:mesh-keep', { digest: value.digest, sessionId: value.sessionId });
      return { state: ['started', 'cancelled', 'refused', 'unavailable'].includes(out?.state) ? out.state : 'unavailable', message: typeof out?.message === 'string' ? out.message.slice(0, 400) : '' };
    } catch { throw new Error(MESH_KEEP_UNAVAILABLE); }
  },
});
// Importing models and effects. The renderer never handles a path: pick() opens the native picker in the main process;
// importFiles(...files) turns files the person dropped into paths here with webUtils.getPathForFile, which only resolves
// real files from a drop or file input. Replies carry opaque import ids, names and plain refusal messages only.
const IMPORT_UNAVAILABLE = 'Importing is unavailable.';
const importReply = out => {
  const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').slice(0, max) : '';
  const rows = value => Array.isArray(value) ? value.slice(0, 16) : [];
  return {
    state: ['imported', 'cancelled', 'refused', 'busy', 'unavailable'].includes(out?.state) ? out.state : 'unavailable', message: text(out?.message, 300),
    imported: rows(out?.imported).filter(row => typeof row?.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id) && (row.kind === 'model' || row.kind === 'effect'))
      .map(row => ({ id: row.id, name: text(row.name, 80), kind: row.kind, duplicate: row.duplicate === true })),
    refused: rows(out?.refused).map(row => ({ name: text(row?.name, 120), message: text(row?.message, 300) })),
  };
};
const assetImport = Object.freeze({ version: 1,
  pick: async (...args) => {
    if (args.length) throw new Error(IMPORT_UNAVAILABLE);
    try { return importReply(await ipcRenderer.invoke('arcane:asset-import-pick')); } catch { throw new Error(IMPORT_UNAVAILABLE); }
  },
  importFiles: async (...files) => {
    if (!files.length || files.length > 8) throw new Error(IMPORT_UNAVAILABLE);
    const { webUtils } = require('electron');
    const paths = files.map(file => { try { const path = webUtils.getPathForFile(file); return typeof path === 'string' ? path : ''; } catch { return ''; } });
    if (paths.some(path => !path || path.length > 4096)) throw new Error('Drop files from your computer to import them.');
    try { return importReply(await ipcRenderer.invoke('arcane:asset-import-files', paths)); } catch { throw new Error(IMPORT_UNAVAILABLE); }
  },
});
const updates = Object.freeze({ version: 1,
  status: async (...args) => {
    if (args.length) throw new Error('Updates are unavailable.');
    const value = await ipcRenderer.invoke('arcane:updates-status');
    if (!value || value.version !== 1 || !['current', 'available', 'unavailable'].includes(value.state) ||
      !(value.buildId === null || typeof value.buildId === 'string' && /^[a-f0-9-]{1,128}$/.test(value.buildId))) throw new Error('Updates are unavailable.');
    return { version: 1, state: value.state, buildId: value.buildId, message: typeof value.message === 'string' ? value.message.slice(0, 400) : '' };
  },
  restart: async (...args) => {
    if (args.length) throw new Error('Updates are unavailable.');
    const value = await ipcRenderer.invoke('arcane:updates-restart');
    if (!value || !['restarting', 'refused', 'unavailable'].includes(value.state)) throw new Error('Updates are unavailable.');
    return { state: value.state, message: typeof value.message === 'string' ? value.message.slice(0, 400) : '' };
  },
});
const RUNTIME_RECOVERY_ERROR = 'Local service recovery is unavailable.';
const recoveryState = value => {
  workspacePreferenceFields(value, ['version', 'state', 'message']);
  if (value.version !== 1 || !['ready', 'stopped', 'saving', 'starting', 'unavailable'].includes(value.state) ||
      typeof value.message !== 'string' || value.message.length > 400 || /[\x00-\x1f\x7f]/.test(value.message)) throw new Error(RUNTIME_RECOVERY_ERROR);
  return { version: 1, state: value.state, message: value.message };
};
const recoveryListen = (channel, listener, checkpoint = false) => {
  if (typeof listener !== 'function') throw new Error(RUNTIME_RECOVERY_ERROR);
  const wrapped = (_event, value) => { try {
    let payload;
    if (checkpoint) { workspacePreferenceFields(value, ['version', 'requestId']);
      if (value.version !== 1 || typeof value.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.requestId)) return;
      payload = { version: 1, requestId: value.requestId };
    } else payload = recoveryState(value);
    Promise.resolve(listener(payload)).catch(() => {});
  } catch {} };
  ipcRenderer.on(channel, wrapped); let active = true;
  return () => { if (active) { active = false; ipcRenderer.removeListener(channel, wrapped); } };
};
const runtimeRecovery = Object.freeze({ version: 1,
  ready: async (...args) => { try { if(args.length)throw new Error(); const value=await ipcRenderer.invoke('arcane:runtime-recovery-ready');workspacePreferenceFields(value,['ready']);if(typeof value.ready!=='boolean')throw new Error();return{ready:value.ready};}catch{throw new Error(RUNTIME_RECOVERY_ERROR);} },
  status: async (...args) => { try { if (args.length) throw new Error(); return recoveryState(await ipcRenderer.invoke('arcane:runtime-recovery-status')); } catch { throw new Error(RUNTIME_RECOVERY_ERROR); } },
  retry: async (...args) => { try { if (args.length) throw new Error(); const value = await ipcRenderer.invoke('arcane:runtime-recovery-retry');
    workspacePreferenceFields(value, ['requested']); if (value.requested !== true) throw new Error(); return { requested: true };
  } catch { throw new Error(RUNTIME_RECOVERY_ERROR); } },
  acknowledge: async (...args) => { try {
    if (args.length !== 1) throw new Error(); const input = args[0]; workspacePreferenceFields(input, ['requestId', 'saved']);
    if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId) || typeof input.saved !== 'boolean') throw new Error();
    const value = await ipcRenderer.invoke('arcane:runtime-recovery-saved', { requestId: input.requestId, saved: input.saved });
    workspacePreferenceFields(value, ['acknowledged']); if (value.acknowledged !== true) throw new Error(); return { acknowledged: true };
  } catch { throw new Error(RUNTIME_RECOVERY_ERROR); } },
  onState: listener => recoveryListen('arcane:runtime-recovery-state', listener),
  onCheckpoint: listener => recoveryListen('arcane:runtime-recovery-checkpoint', listener, true),
});
// This selects human review context only; it never grants a model permission.
const selectAssetConversation = async (...args) => {
  try {
    if (args.length !== 1) throw new Error();
    const value = args[0]; let selection = null;
    if (value !== null) {
      const provider = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'provider') : null;
      if (!provider || !Object.hasOwn(provider, 'value')) throw new Error();
      if (provider.value === 'codex') { handoffFields(value, ['provider']); selection = { provider: 'codex' }; }
      else {
        handoffFields(value, ['provider', 'conversationId']);
        if (!['claude-code', 'arcane'].includes(provider.value) || typeof value.conversationId !== 'string' ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(value.conversationId)) throw new Error();
        selection = { provider: provider.value, conversationId: value.conversationId };
      }
    }
    const reply = handoffFields(await ipcRenderer.invoke('arcane:asset-conversation-select', selection), ['state']);
    if (reply.state !== 'selected' && reply.state !== 'unavailable') throw new Error();
    return { state: reply.state };
  } catch { throw new Error('Model review conversation is unavailable.'); }
};
// Pyx pop-out bar, workspace side (pyx-link.ts): the perch toggles the bar, publish a bounded snapshot, answer the bar's requests.
const pyx = Object.freeze({ version: 1,
  // The perch's click: opens the bar when it is closed and closes it (with its pop-out) when it is open.
  open: (...args) => { if (args.length) throw new Error('Pyx is unavailable.'); return ipcRenderer.invoke('arcane:pyx-toggle').catch(() => ({ opened: false })); },
  isOpen: () => ipcRenderer.invoke('arcane:pyx-is-open').then(open => open === true, () => false),
  onVisibility: listener => {
    if (typeof listener !== 'function') throw new Error('Pyx is unavailable.');
    const handler = (_event, open) => { try { listener(open === true); } catch { /* ignored */ } };
    ipcRenderer.on('arcane:pyx-visibility', handler); return () => { ipcRenderer.removeListener('arcane:pyx-visibility', handler); };
  },
  // Where the composer is (viewport CSS pixels), so the bar first opens clear of it.
  layout: rect => { try { const n = v => typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null; const r = rect && { x: n(rect.x), y: n(rect.y), width: n(rect.width), height: n(rect.height) };
    ipcRenderer.send('arcane:pyx-layout', r && Object.values(r).every(v => v !== null) ? r : null); } catch { /* the bar is optional */ } },
  publish: snapshot => { try { ipcRenderer.send('arcane:pyx-publish', JSON.parse(JSON.stringify(snapshot ?? null))); } catch { /* the bar is optional */ } },
  onRequest: listener => {
    if (typeof listener !== 'function') throw new Error('Pyx is unavailable.');
    const handler = (_event, request) => { try { listener(request); } catch { /* ignored */ } };
    ipcRenderer.on('arcane:pyx-request', handler); return () => { ipcRenderer.removeListener('arcane:pyx-request', handler); };
  },
  answer: (id, result) => ipcRenderer.send('arcane:pyx-answer', { id: String(id).slice(0, 64), accepted: result?.accepted === true,
    message: typeof result?.message === 'string' ? result.message.slice(0, 300) : null }),
});
// Window chrome: the native window buttons' background follows the surface shown ('workspace' or the sign-in 'page').
const windowChrome = Object.freeze({ version: 1,
  tone: (...args) => {
    if (args.length !== 1 || (args[0] !== 'workspace' && args[0] !== 'page')) throw new Error('Window chrome is unavailable.');
    ipcRenderer.send('arcane:titlebar-tone', args[0]);
  },
});
contextBridge.exposeInMainWorld('arcaneDesktop', Object.freeze({ version: '0.1.0', platform: 'win32', runtime: 'desktop', selectAssetConversation, codeVerification, providerSetup, nativeHandoff, studioKeys, conversationLibrary, chatQueue, workspacePreferences, claudePreferences, toolDrafts, welcomeTour, setupChecklist, claudeChat, arcaneChat, studioPlugin, workspaceProject, dialogs, projectPermissions, billing, notifications, meshKeep, assetImport, updates, runtimeRecovery, pyx, windowChrome }));
