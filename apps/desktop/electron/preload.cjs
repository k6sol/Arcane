'use strict';
const { contextBridge } = require('electron');
// Read-only product identity. No generic IPC, secrets, file, process or shell capability.
contextBridge.exposeInMainWorld('arcaneDesktop', Object.freeze({ version: '0.1.0', platform: 'win32', runtime: 'desktop' }));
