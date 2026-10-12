'use strict';
const { resolve, relative, isAbsolute, sep, parse } = require('node:path');
const { lstat, realpath } = require('node:fs/promises');
function validOrigin(origin) {
  return typeof origin === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(origin) && Number(origin.split(':').pop()) <= 65535;
}
function navigationAllowed(origin, input) {
  if (!validOrigin(origin) || typeof input !== 'string' || input.length > 8192) return false;
  try { const url = new URL(input); return url.origin === origin && url.username === '' && url.password === '' && !url.search && ['/studio', '/'].includes(url.pathname); } catch { return false; }
}
function requestAllowed(origin, input) {
  if (!validOrigin(origin) || typeof input !== 'string' || input.length > 8192) return false;
  try { const url = new URL(input); return url.origin === origin && url.username === '' && url.password === '' && ['http:', 'blob:'].includes(url.protocol); } catch { return false; }
}
function within(root, path) { const rel = relative(resolve(root), resolve(path)); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); }
function localPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || /^(?:\\\\|\/\/)/.test(value) || resolve(value) === parse(value).root) throw new Error('Expected a direct local directory.');
  const root = parse(value).root, segments = value.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//);
  if (segments.some(p => p === '.' || p === '..') || (process.platform === 'win32' && segments.some(p => /[<>:"|?*]|[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))) throw new Error('Unsafe directory segment.');
  return resolve(value);
}
async function directPath(value, kind = 'directory', missing = false) {
  const path = localPath(value); let current = path;
  for (;;) {
    try { const info = await lstat(current); const actual = await realpath(current); const same = process.platform === 'win32' ? actual.toLowerCase() === current.toLowerCase() : actual === current;
      if (info.isSymbolicLink() || !same || (current === path ? (kind === 'file' ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()) : !info.isDirectory())) throw new Error('Arcane paths cannot be linked, redirected or special files.');
    } catch (error) { if (error.code !== 'ENOENT' || !missing) throw error; }
    const parent = resolve(current, '..'); if (parent === current) break; current = parent;
  }
  return path;
}
function daemonEnvironment(source, { productRoot, stateRoot, projectPath }) {
  const env = {};
  // Carry operating-system paths, not API keys, Node injection or parent agent configuration.
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'userprofile', 'home', 'homedrive', 'homepath', 'localappdata', 'appdata', 'temp', 'tmp', 'programfiles', 'programfiles(x86)', 'programw6432', 'lang', 'lc_all']);
  for (const [key, value] of Object.entries(source)) if (allowed.has(key.toLowerCase()) && typeof value === 'string') env[key] = value;
  env.ARCANE_PORT = '0'; env.ARCANE_RESOURCE_DIRECTORY = localPath(productRoot); env.ARCANE_STATE_DIRECTORY = localPath(stateRoot); env.ARCANE_PROJECT = localPath(projectPath);
  return env;
}
function readyMessage(message) {
  if (!message || typeof message !== 'object' || Object.keys(message).sort().join(',') !== 'origin,protocolVersion,token,type' || message.type !== 'arcane-ready' || message.protocolVersion !== 1 || !validOrigin(message.origin) || !/^[a-f0-9]{64}$/.test(message.token)) throw new Error('Invalid private daemon handoff.');
  return { origin: message.origin, token: message.token };
}
module.exports = { validOrigin, navigationAllowed, requestAllowed, within, localPath, directPath, daemonEnvironment, readyMessage };
