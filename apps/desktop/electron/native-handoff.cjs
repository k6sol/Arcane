'use strict';

// Main-process preparation only. It writes ONE owned per-launch Arcane-only MCP config and returns exact argv
// plus a fixed environment overlay for a future explicit human native Claude Code handoff. It never spawns,
// activates or prompts a native client, never reads provider credentials, keychains, OAuth or API keys, and
// never falls back to the generic core token. Native human permission controls stay with the vendor client.
// Preparation is not a launch and grants no route authority.
const nativeFs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { types } = require('node:util');
const nativePath = require('node:path');

const CONFIG_NAME = 'arcane.mcp.json';
const DIRECTORY_PREFIX = 'claude-handoff-';
// Installed Claude Code 2.1.177 `--effort` choices; anything else is refused, never downgraded.
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const DAEMON_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
const FS_METHODS = Object.freeze(['realpath', 'lstat', 'mkdir', 'open', 'readdir', 'readFile', 'unlink', 'rmdir']);
const OPTION_KEYS = Object.freeze(['projectPath', 'runtimeDirectory', 'nodePath', 'mcpEntry', 'daemonUrl', 'credential', 'model', 'effort', 'assertCurrent']);

class NativeHandoffPreparationError extends Error {
  constructor(code) { super('Native handoff preparation is unavailable (' + code + ').'); this.name = 'NativeHandoffPreparationError'; this.code = code; }
}
const fail = code => { throw new NativeHandoffPreparationError(code); };

/** Plain own data only: a proxy is refused before any trap and accessors are never invoked. */
function plainOptions(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail('INPUT');
  const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
  if (prototype !== Object.prototype && prototype !== null || keys.length !== OPTION_KEYS.length ||
      keys.some(key => typeof key !== 'string' || !OPTION_KEYS.includes(key))) fail('INPUT');
  const out = Object.create(null);
  for (const key of OPTION_KEYS) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) fail('INPUT');
    out[key] = field.value;
  }
  return out;
}
const pathText = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !CONTROL.test(value) && nativePath.isAbsolute(value);
const digest = text => createHash('sha256').update(text).digest('hex');

function createNativeHandoff(options = {}) {
  // Trusted main-process seam for tests only; never an IPC payload.
  if (!options || typeof options !== 'object' || types.isProxy(options)) fail('INPUT');
  const prototype = Object.getPrototypeOf(options), keys = Reflect.ownKeys(options);
  if (prototype !== Object.prototype && prototype !== null || keys.some(key => key !== 'fs')) fail('INPUT');
  let source = nativeFs;
  if (keys.length) {
    const field = Object.getOwnPropertyDescriptor(options, 'fs');
    if (!field || !Object.hasOwn(field, 'value')) fail('INPUT');
    source = field.value;
    if (!source || typeof source !== 'object' || types.isProxy(source)) fail('INPUT');
    const sourcePrototype = Object.getPrototypeOf(source);
    if (sourcePrototype !== Object.prototype && sourcePrototype !== null) fail('INPUT');
  }
  // Snapshot exactly the methods used, as own data functions. Trusted methods themselves are not sandboxed.
  const fs = Object.create(null);
  for (const name of FS_METHODS) {
    const field = Object.getOwnPropertyDescriptor(source, name);
    if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'function' || types.isProxy(field.value)) fail('INPUT');
    fs[name] = field.value.bind(source);
  }
  Object.freeze(fs);
  const owned = new WeakMap();

  /** Synchronous owner check: exactly undefined. A real (cross-realm too) promise is observed, then refused. */
  function current(assertCurrent) {
    let result;
    try { result = assertCurrent(); } catch { fail('OWNER'); }
    if (result !== undefined) { if (types.isPromise(result)) void Promise.prototype.catch.call(result, () => {}); fail('OWNER'); }
  }
  /** A direct path: canonical (realpath identical), not a link, files with exactly one link. */
  async function direct(path, kind) {
    let real, stat;
    try { real = await fs.realpath(path); stat = await fs.lstat(path); } catch { fail('PATH'); }
    if (real !== path || stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('PATH');
    return stat;
  }
  /** The owned directory is still exactly runtimeDirectory/<name>: same direct, canonical parent identity and a canonical child.
   * Cooperative check-then-use only; it narrows but cannot close a filesystem race window. */
  async function located(record) {
    try {
      const parent = await fs.lstat(record.parent);
      if (parent.isSymbolicLink() || !parent.isDirectory() || parent.dev !== record.parentDev || parent.ino !== record.parentIno) return false;
      return await fs.realpath(record.parent) === record.parent && await fs.realpath(record.directory) === record.directory;
    } catch { return false; }
  }
  /** Remove only the exact unchanged owned config and its then-empty directory; otherwise retain everything. */
  async function removeOwned(record) {
    try {
      if (!await located(record)) return 'changed';
      const directory = await fs.lstat(record.directory);
      if (directory.isSymbolicLink() || !directory.isDirectory() || directory.dev !== record.directoryDev || directory.ino !== record.directoryIno) return 'changed';
      const names = await fs.readdir(record.directory);
      if (record.fileIno === null) { if (names.length) return 'changed'; await fs.rmdir(record.directory); return 'removed'; }
      if (names.length !== 1 || names[0] !== CONFIG_NAME) return 'changed';
      const file = await fs.lstat(record.configPath);
      if (file.isSymbolicLink() || !file.isFile() || file.nlink !== 1 || file.dev !== record.fileDev || file.ino !== record.fileIno || file.size !== record.bytes) return 'changed';
      if (digest(await fs.readFile(record.configPath, 'utf8')) !== record.sha256) return 'changed';
      await fs.unlink(record.configPath);
      await fs.rmdir(record.directory);
      return 'removed';
    } catch { return 'unavailable'; }
  }

  async function prepare(input) {
    // Validate and snapshot everything before the first await.
    const o = plainOptions(input);
    if (typeof o.assertCurrent !== 'function' || types.isProxy(o.assertCurrent)) fail('INPUT');
    for (const key of ['projectPath', 'runtimeDirectory', 'nodePath', 'mcpEntry']) if (!pathText(o[key])) fail('PATH');
    const port = typeof o.daemonUrl === 'string' ? DAEMON_URL.exec(o.daemonUrl) : null;
    if (!port || Number(port[1]) > 65535) fail('DAEMON_URL');
    if (typeof o.credential !== 'string' || !CREDENTIAL.test(o.credential)) fail('CREDENTIAL');
    if (typeof o.model !== 'string' || !MODEL.test(o.model)) fail('SELECTION');
    if (typeof o.effort !== 'string' || !EFFORTS.includes(o.effort)) fail('SELECTION');
    const s = Object.freeze({ projectPath: o.projectPath, runtimeDirectory: o.runtimeDirectory, nodePath: o.nodePath, mcpEntry: o.mcpEntry,
      daemonUrl: o.daemonUrl, credential: o.credential, model: o.model, effort: o.effort });
    // argv, receipt paths and the config are public: the credential may appear only in the non-enumerable env.
    for (const value of [s.projectPath, s.runtimeDirectory, s.nodePath, s.mcpEntry, s.daemonUrl, s.model, s.effort]) if (value.includes(s.credential)) fail('CREDENTIAL');
    const assertCurrent = o.assertCurrent;
    current(assertCurrent);
    await direct(s.projectPath, 'directory'); current(assertCurrent);
    const parent = await direct(s.runtimeDirectory, 'directory'); current(assertCurrent);
    await direct(s.nodePath, 'file'); current(assertCurrent);
    await direct(s.mcpEntry, 'file'); current(assertCurrent);
    const config = JSON.stringify({ mcpServers: { arcane: { type: 'stdio', command: s.nodePath, args: [s.mcpEntry, '--project', s.projectPath],
      env: { ARCANE_DAEMON_URL: '${ARCANE_DAEMON_URL}', ARCANE_LOCAL_TOKEN: '${ARCANE_LOCAL_TOKEN}' } } } }, null, 2) + '\n';
    if (config.includes(s.credential)) fail('CREDENTIAL');
    const directory = nativePath.join(s.runtimeDirectory, DIRECTORY_PREFIX + randomUUID()), configPath = nativePath.join(directory, CONFIG_NAME);
    const record = { parent: s.runtimeDirectory, parentDev: parent.dev, parentIno: parent.ino, directory, configPath, directoryDev: 0, directoryIno: 0, fileDev: 0, fileIno: null, bytes: 0, sha256: digest(''), cleaned: false };
    // Until the full write completes, the owned file is the exclusively created empty file.
    const finalBytes = Buffer.byteLength(config), finalSha256 = digest(config);
    // Exclusive creation: an existing directory or file is never reused or overwritten, and nothing is retried.
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch { fail('FILESYSTEM'); }
    let handle = null;
    try {
      const made = await fs.lstat(directory);
      if (made.isSymbolicLink() || !made.isDirectory()) fail('PATH');
      record.directoryDev = made.dev; record.directoryIno = made.ino;
      if (!await located(record)) fail('PATH'); // never write a config into a replaced or redirected parent
      current(assertCurrent);
      handle = await fs.open(configPath, 'wx', 0o600);
      const opened = await handle.stat(); record.fileDev = opened.dev; record.fileIno = opened.ino;
      if (!await located(record)) fail('PATH');
      current(assertCurrent);
      await handle.writeFile(config, 'utf8');
      record.bytes = finalBytes; record.sha256 = finalSha256;
      await handle.close(); handle = null;
      if (!await located(record)) fail('PATH');
      current(assertCurrent);
    } catch (error) {
      if (handle) try { await handle.close(); } catch { /* retained below if unchanged checks fail */ }
      if (record.directoryIno) await removeOwned(record); // exact owned material only; changed/extra content is retained
      if (error instanceof NativeHandoffPreparationError) throw error;
      fail('FILESYSTEM');
    }
    const argv = Object.freeze(['--mcp-config', configPath, '--strict-mcp-config', '--model', s.model, '--effort', s.effort, '--permission-mode', 'default']);
    const env = Object.freeze({ ARCANE_DAEMON_URL: s.daemonUrl, ARCANE_LOCAL_TOKEN: s.credential });
    const receipt = { handoffDirectory: directory, configPath, configSha256: record.sha256, argv };
    Object.defineProperty(receipt, 'env', { value: env, enumerable: false });
    Object.freeze(receipt);
    owned.set(receipt, record);
    return receipt;
  }

  /** Host-only cleanup of one prepared receipt: exact unchanged owned file and its empty directory only. */
  async function cleanup(receipt) {
    const record = receipt && typeof receipt === 'object' ? owned.get(receipt) : undefined;
    if (!record) fail('RECEIPT');
    if (record.cleaned) return Object.freeze({ state: 'unavailable', reason: 'already_cleaned' });
    const outcome = await removeOwned(record);
    if (outcome === 'removed') { record.cleaned = true; return Object.freeze({ state: 'removed', reason: null }); }
    return Object.freeze({ state: 'unavailable', reason: outcome === 'changed' ? 'owned_material_changed' : 'filesystem_unavailable' });
  }
  return Object.freeze({ prepare, cleanup });
}

module.exports = { createNativeHandoff, NativeHandoffPreparationError, NATIVE_HANDOFF_EFFORTS: EFFORTS };
