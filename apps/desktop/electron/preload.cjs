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
contextBridge.exposeInMainWorld('arcaneDesktop', Object.freeze({ version: '0.1.0', platform: 'win32', runtime: 'desktop', codeVerification }));
