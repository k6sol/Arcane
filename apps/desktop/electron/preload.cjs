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
contextBridge.exposeInMainWorld('arcaneDesktop', Object.freeze({ version: '0.1.0', platform: 'win32', runtime: 'desktop', codeVerification, providerSetup }));
