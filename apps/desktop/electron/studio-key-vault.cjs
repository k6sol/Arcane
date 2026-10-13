'use strict';
// Arcane's own local Studio keys only. No provider credentials or renderer-selected paths.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const policy = require('./policy.cjs');
const FILE = 'studio-key-vault.v1.json';
const MAX_ITEMS = 32, MAX_FILE_BYTES = 32768, MAX_PLAIN_BYTES = 8192;
const ERROR = 'Arcane Studio key storage is unavailable.';
const fail = () => { throw new Error(ERROR); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameNode = (a, b) => ['dev', 'ino', 'mode', 'nlink'].every(key => a[key] === b[key]);
const sameFile = (a, b) => sameNode(a, b) && ['size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

function fields(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== names.length || names.some(name => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) fail();
  return value;
}
function keyId(value) {
  if (typeof value !== 'string' || value.length !== 36 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail();
  return value;
}
function apiKey(value, origin) {
  if (typeof value !== 'string' || value.length > 92) fail();
  const match = /^arcane_local_v1_([1-9][0-9]{0,4})_([a-f0-9]{64})$/.exec(value);
  if (!match || match[0] !== value || Number(match[1]) > 65535 || new URL(origin).port !== match[1]) fail();
  return value;
}
function checkedPath(value, kind = 'directory') {
  const full = policy.localPath(value);
  if (!samePath(full, value)) fail();
  const root = path.parse(full).root, parts = full.slice(root.length).split(path.sep).filter(Boolean);
  if (parts.length > 64) fail();
  const chain = []; let current = root;
  for (const part of [null, ...parts]) {
    if (part !== null) current = path.join(current, part);
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || !samePath(fs.realpathSync(current), current) ||
        (samePath(current, full) && kind === 'file' ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) fail();
    chain.push({ path: current, stat });
  }
  return chain;
}
function checkChain(chain) {
  const after = checkedPath(chain.at(-1).path, chain.at(-1).stat.isFile() ? 'file' : 'directory');
  if (after.length !== chain.length || chain.some((node, i) => !sameNode(node.stat, after[i].stat))) fail();
  return after;
}
function missing(full) {
  try { fs.lstatSync(full); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function readBounded(fd) {
  const bytes = Buffer.alloc(MAX_FILE_BYTES + 1); let length = 0;
  while (length < bytes.length) {
    const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
    if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - length) fail();
    if (!count) break;
    length += count;
  }
  if (length > MAX_FILE_BYTES) fail();
  return bytes.subarray(0, length);
}
function openPin(full) {
  const chain = checkedPath(full, 'file'), before = chain.at(-1).stat;
  if (before.size > BigInt(MAX_FILE_BYTES)) fail();
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const pin = { full, fd, chain, before };
    const bytes = checkPin(pin); pin.digest = hash(bytes);
    return { pin, bytes };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function checkPin(pin) {
  const first = fs.fstatSync(pin.fd, { bigint: true }), bytes = readBounded(pin.fd);
  const last = fs.fstatSync(pin.fd, { bigint: true }), current = checkChain(pin.chain).at(-1).stat;
  if (!sameFile(pin.before, first) || !sameFile(first, last) || !sameFile(last, current) ||
      BigInt(bytes.length) !== last.size || (pin.digest !== undefined && pin.digest !== hash(bytes))) fail();
  return bytes;
}

function createStudioKeyVault({ safeStorage, clipboard, getSession, enabled = true }) {
  // Construction/install are inert, including in smoke mode. All reads are gated IPC intents.
  let busy = false;
  function available() {
    return enabled === true && process.platform === 'win32' &&
      typeof safeStorage?.encryptString === 'function' && typeof safeStorage?.decryptString === 'function' &&
      typeof safeStorage?.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable() === true;
  }
  function current(event) {
    const session = getSession(), contents = session?.window?.webContents, frame = event?.senderFrame;
    if (!session || session.window.isDestroyed() || !contents || contents.isDestroyed() ||
        event.sender !== contents || !frame || frame !== contents.mainFrame || !policy.validOrigin(session.origin) ||
        !policy.navigationAllowed(session.origin, frame.url) || new URL(frame.url).href !== frame.url) fail();
    return { ...session, contents, frame, frameUrl: frame.url };
  }
  function guard(scope, event) {
    const now = current(event);
    if (['epoch', 'window', 'contents', 'frame', 'frameUrl', 'origin', 'projectId', 'projectPath', 'stateRoot', 'userRoot']
      .some(name => now[name] !== scope[name])) fail();
  }
  function projectScope(scope) {
    if (typeof scope.projectId !== 'string' || !/^[a-f0-9]{64}$/.test(scope.projectId) ||
        hash(scope.projectPath.toLowerCase()) !== scope.projectId ||
        !samePath(scope.stateRoot, path.join(scope.userRoot, 'runtime', 'projects', scope.projectId))) fail();
    const projectChain = checkedPath(scope.projectPath), stateChain = checkedPath(scope.stateRoot);
    // The full profile/state parent chain is pinned by checkedPath; no directories are created here.
    const full = path.join(scope.stateRoot, FILE);
    if (!policy.within(scope.stateRoot, full)) fail();
    return { full, projectChain, stateChain };
  }
  function checkSnapshot(snapshot) {
    checkChain(snapshot.projectChain); checkChain(snapshot.stateChain);
    if (snapshot.pin) checkPin(snapshot.pin); else if (!missing(snapshot.full)) fail();
  }
  function payload(value, scope) {
    fields(value, ['version', 'projectId', 'items']);
    if (value.version !== 1 || value.projectId !== scope.projectId || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) fail();
    const ids = new Set();
    for (const item of value.items) {
      fields(item, ['keyId', 'apiKey']); keyId(item.keyId); apiKey(item.apiKey, scope.origin);
      if (ids.has(item.keyId)) fail(); ids.add(item.keyId);
    }
    return value;
  }
  function readSnapshot(scope, event, paths) {
    const snapshot = { ...paths };
    checkChain(snapshot.projectChain); checkChain(snapshot.stateChain);
    guard(scope, event);
    if (missing(snapshot.full)) return { ...snapshot, items: [], pin: null };
    const { pin, bytes } = openPin(snapshot.full); snapshot.pin = pin;
    try {
      const envelope = fields(JSON.parse(bytes.toString('utf8')), ['version', 'ciphertext']);
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || !envelope.ciphertext ||
          !bytes.equals(Buffer.from(JSON.stringify(envelope) + '\n'))) fail();
      const encrypted = Buffer.from(envelope.ciphertext, 'base64');
      if (encrypted.length > MAX_FILE_BYTES / 2 || encrypted.toString('base64') !== envelope.ciphertext) fail();
      guard(scope, event); checkSnapshot(snapshot);
      const plain = safeStorage.decryptString(encrypted);
      guard(scope, event); checkSnapshot(snapshot);
      if (typeof plain !== 'string' || Buffer.byteLength(plain) > MAX_PLAIN_BYTES) fail();
      const decoded = payload(JSON.parse(plain), scope);
      if (JSON.stringify(decoded) !== plain) fail();
      return { ...snapshot, items: decoded.items };
    } catch (error) { fs.closeSync(pin.fd); throw error; }
  }
  function persist(scope, event, snapshot, items) {
    // Both IDs and keys are sealed together, binding decryption to this project.
    const plain = JSON.stringify(payload({ version: 1, projectId: scope.projectId, items }, scope));
    if (Buffer.byteLength(plain) > MAX_PLAIN_BYTES) fail();
    guard(scope, event); checkSnapshot(snapshot); if (!available()) fail();
    const encrypted = safeStorage.encryptString(plain);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_FILE_BYTES / 2) fail();
    const bytes = Buffer.from(JSON.stringify({ version: 1, ciphertext: encrypted.toString('base64') }) + '\n');
    if (bytes.length > MAX_FILE_BYTES) fail();
    const lock = snapshot.full + '.lock', temp = snapshot.full + '.' + randomUUID() + '.tmp';
    let lockFd, tempFd, lockChain, tempChain;
    try {
      guard(scope, event); checkSnapshot(snapshot);
      lockFd = fs.openSync(lock, 'wx+', 0o600); lockChain = checkedPath(lock, 'file');
      if (!sameFile(lockChain.at(-1).stat, fs.fstatSync(lockFd, { bigint: true }))) fail();
      guard(scope, event); checkSnapshot(snapshot);
      tempFd = fs.openSync(temp, 'wx+', 0o600); tempChain = checkedPath(temp, 'file');
      if (!sameFile(tempChain.at(-1).stat, fs.fstatSync(tempFd, { bigint: true }))) fail();
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(tempFd, bytes, written, bytes.length - written);
        if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - written) fail();
        written += count;
      }
      fs.fsyncSync(tempFd); tempChain = checkedPath(temp, 'file');
      if (!sameFile(tempChain.at(-1).stat, fs.fstatSync(tempFd, { bigint: true })) || !readBounded(tempFd).equals(bytes)) fail();
      if (!available()) fail(); guard(scope, event); checkSnapshot(snapshot);
      const lockStat = checkChain(lockChain).at(-1).stat;
      if (!sameFile(lockChain.at(-1).stat, lockStat) || !sameFile(lockStat, fs.fstatSync(lockFd, { bigint: true }))) fail();
      checkChain(tempChain);
      if (!sameFile(tempChain.at(-1).stat, fs.fstatSync(tempFd, { bigint: true }))) fail();
      // Close our handles for Windows rename; never truncate/unlink the previous vault.
      if (snapshot.pin) { fs.closeSync(snapshot.pin.fd); snapshot.pin = null; }
      fs.closeSync(tempFd); tempFd = undefined;
      const stagedStat = tempChain.at(-1).stat;
      fs.renameSync(temp, snapshot.full); tempChain = undefined;
      const saved = openPin(snapshot.full);
      try {
        if (!sameNode(saved.pin.before, stagedStat) || !saved.bytes.equals(bytes)) fail();
        guard(scope, event); checkChain(snapshot.projectChain); checkChain(snapshot.stateChain);
      } finally { fs.closeSync(saved.pin.fd); }
    } finally {
      if (tempFd !== undefined) {
        // Pin our partial write before closing so a failed flush can clean up its own stage.
        try {
          const after = checkChain(tempChain), stat = fs.fstatSync(tempFd, { bigint: true });
          if (!sameNode(tempChain.at(-1).stat, stat) || !sameFile(after.at(-1).stat, stat)) fail();
          tempChain = after;
        } catch { /* A changed/redirected stage remains untouched. */ }
        fs.closeSync(tempFd);
      }
      if (lockFd !== undefined) fs.closeSync(lockFd);
      for (const chain of [tempChain, lockChain]) if (chain) {
        try {
          if (!sameFile(chain.at(-1).stat, checkChain(chain).at(-1).stat)) fail();
          fs.unlinkSync(chain.at(-1).path);
        } catch { /* Preserve foreign or redirected files. */ }
      }
    }
  }
  function installIpc(ipcMain) {
    for (const action of ['list', 'remember', 'reveal', 'forget', 'copy']) {
      ipcMain.handle('arcane:studio-keys-' + action, async (event, ...args) => {
        let ownsBusy = false, snapshot;
        try {
          const scope = current(event);
          let input;
          if (action === 'list') { if (args.length) fail(); }
          else {
            if (args.length !== 1) fail();
            const value = fields(args[0], action === 'remember' ? ['keyId', 'apiKey'] : ['keyId']);
            input = { keyId: keyId(value.keyId) };
            if (action === 'remember') input.apiKey = apiKey(value.apiKey, scope.origin);
          }
          if (busy) fail(); busy = true; ownsBusy = true;
          const usable = available(); guard(scope, event);
          if (!usable) { if (action === 'list') return { available: false, items: [] }; fail(); }
          const paths = projectScope(scope);
          // Pin paths before yielding; recheck owner/main frame/project/origin before key access.
          await Promise.resolve(); guard(scope, event);
          if (!available()) fail(); guard(scope, event);
          snapshot = readSnapshot(scope, event, paths); guard(scope, event); checkSnapshot(snapshot);
          if (action === 'list') return { available: true, items: snapshot.items.map(item => ({ keyId: item.keyId })) };
          const found = snapshot.items.find(item => item.keyId === input.keyId);
          if (action === 'reveal') { if (!found) fail(); return { apiKey: found.apiKey }; }
          if (action === 'copy') {
            if (!found || typeof clipboard?.writeText !== 'function') fail();
            guard(scope, event); checkSnapshot(snapshot);
            // Only a validated key in this window's encrypted project vault.
            // No arbitrary renderer strings, shell commands or clipboard reads.
            clipboard.writeText(found.apiKey);
            guard(scope, event); return { copied: true };
          }
          if (action === 'remember') {
            // Immutable UUID binding: another value must never replace a remembered credential.
            if (found && found.apiKey !== input.apiKey) fail();
            if (!found) {
              if (snapshot.items.length >= MAX_ITEMS) fail();
              persist(scope, event, snapshot, [...snapshot.items, input].sort((a, b) => a.keyId.localeCompare(b.keyId)));
            }
            guard(scope, event); return { remembered: true };
          }
          if (found) persist(scope, event, snapshot, snapshot.items.filter(item => item.keyId !== input.keyId));
          guard(scope, event); return { forgotten: true };
        } catch { fail(); }
        finally {
          try { if (snapshot?.pin) fs.closeSync(snapshot.pin.fd); } catch { fail(); }
          finally { if (ownsBusy) busy = false; }
        }
      });
    }
  }
  return Object.freeze({ installIpc });
}
module.exports = { createStudioKeyVault };
