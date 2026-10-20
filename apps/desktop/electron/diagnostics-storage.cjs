'use strict';
const fs = require('node:fs');
const path = require('node:path');
const FILE = 'outbox.sqlite';
const COMPANIONS = ['', '-wal', '-shm', '-journal'];
const ERROR = 'Arcane diagnostic storage is unavailable.';
const fail = () => {throw new Error(ERROR);};
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;

function directoryPath(value) {
  if (typeof value !== 'string' || !value || value.length > 32700 || /[\x00-\x1f\x7f]/.test(value) ||
      !path.isAbsolute(value) || /^(?:\\\\|\/\/)/.test(value)) fail();
  const root = path.parse(value).root;
  const segments = value.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//);
  if (!segments.length || segments.some(part => !part || part === '.' || part === '..' || process.platform === 'win32' &&
      (/[<>:"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) fail();
  return path.resolve(value);
}
function ancestors(directory) {
  const result = []; let current = path.parse(directory).root; result.push(current);
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {current = path.join(current, part); result.push(current);}
  return result;
}
function node(filename, kind, optional = false) {
  let info;
  try {info = fs.lstatSync(filename, {bigint: true});}
  catch (error) {if (optional && error.code === 'ENOENT') return null; fail();}
  if (info.isSymbolicLink() || kind === 'directory' && !info.isDirectory() || kind === 'file' && (!info.isFile() || info.nlink !== 1n) ||
      !samePath(fs.realpathSync(filename), filename)) fail();
  const after = fs.lstatSync(filename, {bigint: true});
  if (!sameNode(info, after) || kind === 'file' && after.nlink !== 1n || after.isSymbolicLink()) fail();
  return after;
}
function companionFiles(directory) {return new Map(COMPANIONS.map(suffix => {const filename = path.join(directory, FILE + suffix); return [filename, node(filename, 'file', true)];}));}

/** Trusted main-process constructor only. prepareDirectory must establish/verify private directory ownership and ACLs,
 * return its canonical requested path, and refuse unsafe existing storage rather than repair it.
 * This adapter verifies physical paths/file identities; it does not invent an ACL policy or access app profiles. */
async function openDiagnosticsStorage(options) {
  let db, closed = false;
  try {
    if (!options || typeof options.prepareDirectory !== 'function') fail();
    const directory = directoryPath(options.directory), chain = ancestors(directory);
    const prior = new Map();
    for (const item of chain) {const info = node(item, 'directory', true); if (!info) break; prior.set(item, info);}
    const priorFiles = prior.has(directory) ? companionFiles(directory) : new Map();
    const prepared = await options.prepareDirectory(directory);
    if (typeof prepared !== 'string' || !samePath(prepared, directory)) fail();
    const pins = new Map();
    for (const item of chain) {
      const info = node(item, 'directory'); if (prior.has(item) && !sameNode(prior.get(item), info)) fail(); pins.set(item, info);
    }
    const files = companionFiles(directory), filename = path.join(directory, FILE);
    if (priorFiles.get(filename) && (!files.get(filename) || !sameNode(priorFiles.get(filename), files.get(filename)))) fail();
    let databasePin = files.get(filename);
    if (!databasePin) {
      // Reserve the absent fixed file exclusively; a concurrently appearing file is never adopted.
      const fd = fs.openSync(filename, 'wx', 0o600);
      try {
        databasePin = fs.fstatSync(fd, {bigint: true});
        if (!databasePin.isFile() || databasePin.isSymbolicLink() || databasePin.nlink !== 1n) fail();
        fs.fsyncSync(fd);
        if (!sameNode(databasePin, node(filename, 'file'))) fail();
      } finally {fs.closeSync(fd);}
    }
    function assertReady() {
      try {
        if (closed) fail();
        for (const [item, pin] of pins) if (!sameNode(pin, node(item, 'directory'))) fail();
        const current = companionFiles(directory);
        if (!current.get(filename) || !sameNode(databasePin, current.get(filename))) fail();
      } catch {fail();}
    }
    assertReady();
    const transport = (options.sqliteTransportPath ?? path.toNamespacedPath)(filename);
    const direct = typeof transport === 'string' && process.platform === 'win32' && transport.startsWith('\\\\?\\') ? transport.slice(4) : transport;
    if (typeof direct !== 'string' || !samePath(direct, filename)) fail();
    const Database = options.DatabaseSync ?? require('node:sqlite').DatabaseSync;
    db = new Database(transport, {timeout: 1000, allowExtension: false});
    assertReady();
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
    assertReady();
    if (String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase() !== 'wal' ||
        Number(db.prepare('PRAGMA synchronous').get().synchronous) !== 2 ||
        Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys) !== 1 ||
        Number(db.prepare('PRAGMA busy_timeout').get().timeout) !== 1000) fail();
    assertReady();
    return Object.freeze({db, assertReady, close() {if (closed) return; try {assertReady(); db.close(); closed = true;} catch {fail();}}});
  } catch {
    if (db && !closed) {try {db.close();} catch { /* Retain the original generic storage refusal. */ }}
    fail();
  }
}
module.exports = {openDiagnosticsStorage};
