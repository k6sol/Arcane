'use strict';
const { resolve, relative, isAbsolute, sep, parse, join } = require('node:path');
const { lstat, realpath } = require('node:fs/promises');
const { lstatSync, realpathSync, mkdirSync, readdirSync, renameSync, openSync, writeSync, closeSync } = require('node:fs');
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
function protectConsolePipes(outputs) {
  // Desktop launchers can close their inherited pipes while the app remains open.
  // Preserve other stream errors; a disconnected console must not crash an IPC reply.
  for (const output of outputs) output.on('error', error => { if (error?.code !== 'EPIPE') throw error; });
}
function installClipboardPermissions(session, getOwner) {
  function allowed(contents, permission, requestingOrigin, details) {
    try {
      const owner = getOwner(), window = owner?.window;
      if (!owner?.active || !window || window.isDestroyed() || permission !== 'clipboard-sanitized-write' ||
          !contents || contents !== window.webContents || contents.isDestroyed() || details?.isMainFrame !== true ||
          !validOrigin(owner.origin) || requestingOrigin !== owner.origin && requestingOrigin !== owner.origin + '/') return false;
      const frame = contents.mainFrame;
      return !!frame && navigationAllowed(owner.origin, frame.url) && navigationAllowed(owner.origin, details.requestingUrl) &&
        details.requestingUrl === frame.url;
    } catch { return false; }
  }
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => allowed(contents, permission, requestingOrigin, details));
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    let requestingOrigin;
    try { requestingOrigin = new URL(details.requestingUrl).origin; } catch { callback(false); return; }
    callback(allowed(contents, permission, requestingOrigin, details));
  });
}
function within(root, path) { const rel = relative(resolve(root), resolve(path)); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); }
function localPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || /^(?:\\\\|\/\/)/.test(value) || resolve(value) === parse(value).root) throw new Error('Expected a direct local directory.');
  const root = parse(value).root, segments = value.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//);
  if (segments.some(p => p === '.' || p === '..') || (process.platform === 'win32' && (!/^[a-z]:[\\/]$/i.test(root) || segments.some(p => /[<>:"|?*]|[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))))) throw new Error('Unsafe directory segment.');
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

function prepareSmokeDirectory(value) {
  const root = localPath(value);
  const direct = path => { let current = path; for (;;) {
    const info = lstatSync(current), actual = realpathSync(current);
    const same = process.platform === 'win32' ? actual.toLowerCase() === current.toLowerCase() : actual === current;
    if (!info.isDirectory() || info.isSymbolicLink() || !same) throw new Error('Smoke paths must be direct owned directories.');
    const parent = resolve(current, '..'); if (parent === current) break; current = parent;
  } };
  direct(root); if (readdirSync(root).length !== 0) throw new Error('Smoke directory must be empty.');
  const profile = resolve(root, 'profile'); mkdirSync(profile, { mode: 0o700 }); direct(profile); return profile;
}


/** Normalize only the trusted Electron Arcane profile, including Windows MSIX's
 * known AppData virtualization. Arbitrary redirection, links and renderer paths
 * remain forbidden. No permissions or OS settings are changed. */
function prepareUserDirectory(value, { appData, localAppData } = {}) {
  const root = localPath(value), sourceParent = localPath(appData);
  const same = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(require('node:path').dirname(root),sourceParent) || require('node:path').basename(root).toLowerCase() !== 'arcane')
    throw new Error('The trusted Arcane application-data path is required.');
  const physical = realpathSync.native ?? realpathSync;
  function direct(directory) {
    for(let current=directory;;current=resolve(current,'..')) {
      const stat=lstatSync(current);
      if(!stat.isDirectory() || stat.isSymbolicLink() || !same(physical(current),current))
        throw new Error('Arcane profile parents must be direct directories.');
      const parent=resolve(current,'..'); if(parent===current) break;
    }
  }
  direct(sourceParent);
  try { const stat=lstatSync(root); if(!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe Arcane profile.'); }
  catch(error) { if(error.code!=='ENOENT') throw error; mkdirSync(root,{mode:0o700}); }
  const actual=localPath(physical(root));
  if(!same(actual,root)) {
    if(process.platform !== 'win32' || !localAppData) throw new Error('Unexpected Arcane profile redirection.');
    const local=localPath(localAppData); direct(local);
    const rel=relative(resolve(local,'Packages'),actual);
    const parts=rel.split(/[\\/]/);
    if(isAbsolute(rel) || parts.length!==4 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(parts[0]) ||
        parts[1].toLowerCase()!=='localcache' || parts[2].toLowerCase()!=='roaming' || parts[3].toLowerCase()!=='arcane')
      throw new Error('Unexpected Arcane profile redirection.');
  }
  direct(actual); return actual;
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
const STARTUP_FAILURE_CODES = Object.freeze(['PORT_IN_USE', 'STATE_NEWER', 'STATE_UNSAFE', 'RESOURCE_UNAVAILABLE', 'STARTUP_FAILED']);
// A fixed code only: never stderr, paths, exception text or secrets. Never readiness.
function startupFailureMessage(message) {
  if (!message || typeof message !== 'object' || Object.getPrototypeOf(message) !== Object.prototype || Object.keys(message).sort().join(',') !== 'code,protocolVersion,type' || message.type !== 'arcane-startup-failure' || message.protocolVersion !== 1 || typeof message.code !== 'string' || !STARTUP_FAILURE_CODES.includes(message.code)) throw new Error('Invalid private daemon failure report.');
  return message.code;
}
const DAEMON_STDERR_LOG = 'daemon-stderr.log', DAEMON_STDERR_PREVIOUS_LOG = 'daemon-stderr.previous.log', DAEMON_STDERR_LIMIT = 64 * 1024;
/** Bounded diagnostic trail of the owned daemon's stderr (never stdout, which carries the workspace token).
 * The prior run's log is kept once as .previous; an unexpected file kind at either name disables logging
 * rather than following or replacing it. Logging never blocks or fails daemon startup. */
function daemonStderrLog(stateRoot, limit = DAEMON_STDERR_LIMIT) {
  const current = join(stateRoot, DAEMON_STDERR_LOG), previous = join(stateRoot, DAEMON_STDERR_PREVIOUS_LOG);
  const plain = path => {
    try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1; }
    catch (error) { return error.code === 'ENOENT' ? null : false; }
  };
  let fd;
  try {
    const existing = plain(current); if (existing === false) return null;
    if (existing) { if (plain(previous) === false) return null; renameSync(current, previous); }
    fd = openSync(current, 'wx', 0o600);
  } catch { return null; }
  let written = 0, closed = false;
  const close = () => { if (closed) return; closed = true; try { closeSync(fd); } catch { /* Diagnostics only. */ } };
  const write = text => { const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'); writeSync(fd, bytes); written += bytes.length; };
  try { write('[Arcane local runtime stderr, started ' + new Date().toISOString() + ']\n'); } catch { close(); return null; }
  return Object.freeze({
    path: current,
    attach(stream) {
      // Always drain the pipe so a chatty child never blocks; persist only the bounded prefix.
      stream.on('data', chunk => {
        if (closed) return;
        try {
          const room = limit - written;
          if (chunk.length <= room) { write(chunk); return; }
          if (room > 0) write(chunk.subarray(0, room));
          write('\n[truncated at ' + limit + ' bytes]\n'); close();
        } catch { close(); }
      });
      stream.once('close', close); stream.once('error', close);
    },
    close,
  });
}
module.exports = { daemonStderrLog, DAEMON_STDERR_LOG, DAEMON_STDERR_LIMIT, validOrigin, navigationAllowed, requestAllowed, protectConsolePipes, installClipboardPermissions, within, localPath, directPath, prepareSmokeDirectory, prepareUserDirectory, daemonEnvironment, readyMessage, STARTUP_FAILURE_CODES, startupFailureMessage };
