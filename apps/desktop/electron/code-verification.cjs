'use strict';
// Native host policy only. This module never executes, downloads or copies a compiler.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const policy = require('./policy.cjs');
const COMPILER_SHA256 = '74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8';
const COMPILER_BYTES = 1403904;
const SETTINGS_FILE = 'luau-verification.json';
const MAX_SETTINGS_BYTES = 4096;
const ENV_KEYS = ['ARCANE_LUAU_COMPILER_PATH', 'ARCANE_LUAU_COMPILER_SHA256', 'ARCANE_LUAU_EVIDENCE_DIRECTORY'];
const PRIVATE = new Set(['.git', '.codex', '.claude', '.claude-code', '.agents', '.aws', '.ssh', '.azure', '.env', '.config', '.arcane',
  '.arcane-private-receipts-v1', 'workflow-human-receipts', 'native-codex', '.gnupg', '.kube', '.npm', '.docker', '.pki', '.vscode', '.idea',
  'node_modules', 'config', 'credentials', 'secrets', '.credentials', '.secrets', 'runtime', '.runtime']);
const PRIVATE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.gitconfig|\.git-credentials|\.claude\.json|\.codexrc|auth\.json|credentials(?:\.json)?|secrets(?:\.json)?|tokens?\.json|key-v1|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|config\.toml)$/i;
const PRIVATE_EXTENSION = /\.(?:pem|key|p12|pfx|jks|kdbx|sqlite(?:3)?(?:-wal|-shm|-journal)?)$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ud800-\udfff]/u;
const fail = () => { throw new Error('Luau verification configuration is unavailable.'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameNode = (a, b) => ['dev', 'ino', 'mode', 'nlink'].every(key => a[key] === b[key]);
const sameFile = (a, b) => sameNode(a, b) && ['size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const encode = settings => Buffer.from(JSON.stringify(settings) + '\n');

function absolute(value) {
  if (typeof value !== 'string' || value !== value.normalize('NFKC') || CONTROL.test(value) || Buffer.byteLength(value) > 2048) fail();
  const full = policy.localPath(value);
  if (!samePath(full, value)) fail();
  return full;
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value !== value.normalize('NFKC') || CONTROL.test(value) ||
      Buffer.byteLength(value) > 245 || value.includes('\\') || path.isAbsolute(value)) fail();
  if (value.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*]|[. ]$/.test(part) ||
      PRIVATE.has(part.toLowerCase()) || PRIVATE_FILE.test(part) || PRIVATE_EXTENSION.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail();
  return value;
}
function checkedPath(value, kind = 'directory') {
  const full = absolute(value), root = path.parse(full).root;
  const parts = full.slice(root.length).split(path.sep).filter(Boolean);
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
  if (after.length !== chain.length || chain.some((node, i) => !samePath(node.path, after[i].path) || !sameNode(node.stat, after[i].stat))) fail();
  return after;
}
function readBounded(fd, bound) {
  const bytes = Buffer.alloc(bound + 1); let length = 0;
  while (length < bytes.length) {
    const remaining = bytes.length - length;
    const count = fs.readSync(fd, bytes, length, remaining, length);
    if (!Number.isSafeInteger(count) || count < 0 || count > remaining) fail();
    if (!count) break;
    length += count;
  }
  if (length > bound) fail();
  return bytes.subarray(0, length);
}
function openPin(full, bound, expectedDigest, expectedBytes) {
  const chain = checkedPath(full, 'file'), initial = chain.at(-1).stat;
  if (initial.size > BigInt(bound) || (expectedBytes !== undefined && initial.size !== BigInt(expectedBytes))) fail();
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!sameFile(initial, before)) fail();
    const pin = { fd, full, before, chain, bound, digest: expectedDigest, bytes: expectedBytes };
    const bytes = checkPin(pin);
    pin.digest = digest(bytes); pin.bytes = bytes.length;
    return { pin, bytes };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function checkPin(pin) {
  const first = fs.fstatSync(pin.fd, { bigint: true }), bytes = readBounded(pin.fd, pin.bound);
  const last = fs.fstatSync(pin.fd, { bigint: true }), current = checkChain(pin.chain).at(-1).stat;
  if (!sameFile(pin.before, first) || !sameFile(first, last) || !sameFile(last, current) ||
      (pin.bytes !== undefined && bytes.length !== pin.bytes) || (pin.digest !== undefined && digest(bytes) !== pin.digest)) fail();
  return bytes;
}
function missingFile(full) {
  try { fs.lstatSync(full); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function settingsTuple(value, projectId) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== 'compilerPath,compilerSha256,evidenceDirectory,projectId,version' ||
      value.version !== 1 || value.projectId !== projectId || value.compilerSha256 !== COMPILER_SHA256 ||
      path.basename(absolute(value.compilerPath)).toLowerCase() !== 'luau-compile.exe') fail();
  safeRelative(value.evidenceDirectory);
  return { version: 1, projectId, compilerPath: value.compilerPath, compilerSha256: COMPILER_SHA256, evidenceDirectory: value.evidenceDirectory };
}
function projectScope(project) {
  if (!project || !/^[a-f0-9]{64}$/.test(project.projectId)) fail();
  const projectChain = checkedPath(project.projectPath), stateChain = checkedPath(project.stateRoot);
  const expectedId = digest(process.platform === 'win32' ? project.projectPath.toLowerCase() : project.projectPath);
  if (expectedId !== project.projectId || path.basename(project.stateRoot) !== project.projectId ||
      !samePath(project.stateRoot, path.join(path.dirname(path.dirname(project.stateRoot)), 'projects', project.projectId))) fail();
  return { projectChain, stateChain, full: path.join(project.stateRoot, SETTINGS_FILE) };
}
function evidence(project, selected) {
  const full = absolute(selected), chain = checkedPath(full);
  if (!policy.within(project.projectPath, full)) fail();
  const relative = safeRelative(path.relative(project.projectPath, full).split(path.sep).join('/'));
  // Owned runtime records and their ancestors/descendants are never project evidence.
  if (samePath(full, project.stateRoot) || policy.within(project.stateRoot, full) || policy.within(full, project.stateRoot)) fail();
  return { relative, chain };
}

function createCodeVerification({ dialog, getSession, smoke = false }) {
  const observed = new Map(); let configuring = false;
  function readSettings(project) {
    const scope = projectScope(project), prior = observed.get(project.projectId);
    if (prior && !samePath(prior.full, scope.full)) fail();
    if (prior) { checkChain(prior.projectChain); checkChain(prior.stateChain); }
    if (missingFile(scope.full)) {
      if (prior?.digest) fail();
      observed.set(project.projectId, { full: scope.full, digest: null, projectChain: scope.projectChain, stateChain: scope.stateChain });
      return { ...scope, settings: null, hash: null, pin: null };
    }
    const { pin, bytes } = openPin(scope.full, MAX_SETTINGS_BYTES);
    try {
      const settings = settingsTuple(JSON.parse(bytes.toString('utf8')), project.projectId);
      if (!bytes.equals(encode(settings)) || (prior && prior.digest !== pin.digest)) fail();
      if (prior?.stat && !sameFile(prior.stat, pin.before)) fail();
      observed.set(project.projectId, { full: scope.full, digest: pin.digest, stat: pin.before, projectChain: scope.projectChain, stateChain: scope.stateChain });
      return { ...scope, settings, hash: pin.digest, pin };
    } catch (error) { fs.closeSync(pin.fd); throw error; }
  }
  function checkSnapshot(snapshot) {
    checkChain(snapshot.projectChain); checkChain(snapshot.stateChain);
    if (snapshot.pin) checkPin(snapshot.pin); else if (!missingFile(snapshot.full)) fail();
  }
  function current() {
    const session = getSession();
    if (!session || !session.window || session.window.isDestroyed() || !policy.validOrigin(session.origin)) fail();
    return session;
  }
  function stillCurrent(session) {
    const now = current();
    if (now.epoch !== session.epoch || now.window !== session.window || now.origin !== session.origin ||
        now.projectId !== session.projectId || now.projectPath !== session.projectPath || now.stateRoot !== session.stateRoot) fail();
  }
  function result(session, snapshot, cancelled = false) {
    return Object.freeze({ version: 1, projectId: session.projectId, configured: snapshot.settings !== null,
      pendingRestart: snapshot.hash !== session.activeSettingsHash, evidenceDirectory: snapshot.settings?.evidenceDirectory ?? null, cancelled });
  }
  function statusValue(session, cancelled = false) {
    const snapshot = readSettings(session);
    try { stillCurrent(session); checkSnapshot(snapshot); return result(session, snapshot, cancelled); }
    finally { if (snapshot.pin) fs.closeSync(snapshot.pin.fd); }
  }
  async function status(...args) {
    try { if (args.length) fail(); return statusValue(current()); } catch { fail(); }
  }
  function persist(session, snapshot, settings) {
    const lock = path.join(session.stateRoot, SETTINGS_FILE + '.lock');
    const temp = path.join(session.stateRoot, SETTINGS_FILE + '.' + randomUUID() + '.tmp');
    let lockFd, tempFd, lockChain, tempChain, lockStat;
    try {
      stillCurrent(session); checkSnapshot(snapshot);
      lockFd = fs.openSync(lock, 'wx', 0o600); lockChain = checkedPath(lock, 'file');
      lockStat = fs.fstatSync(lockFd, { bigint: true });
      if (!sameFile(lockStat, lockChain.at(-1).stat)) fail();
      stillCurrent(session); checkSnapshot(snapshot);
      tempFd = fs.openSync(temp, 'wx+', 0o600);
      const bytes = encode(settings); let written = 0;
      while (written < bytes.length) {
        const remaining = bytes.length - written;
        const count = fs.writeSync(tempFd, bytes, written, remaining);
        if (!Number.isSafeInteger(count) || count < 1 || count > remaining) fail();
        written += count;
      }
      fs.fsyncSync(tempFd); tempChain = checkedPath(temp, 'file');
      if (!sameFile(fs.fstatSync(tempFd, { bigint: true }), tempChain.at(-1).stat) || !readBounded(tempFd, MAX_SETTINGS_BYTES).equals(bytes)) fail();
      stillCurrent(session); checkSnapshot(snapshot); checkChain(lockChain); checkChain(tempChain);
      if (!sameFile(lockStat, fs.fstatSync(lockFd, { bigint: true })) || !sameFile(lockStat, fs.lstatSync(lock, { bigint: true })) ||
          !sameFile(tempChain.at(-1).stat, fs.fstatSync(tempFd, { bigint: true }))) fail();
      // No unlink/truncate of the old settings. Windows requires closing our handles before rename.
      if (snapshot.pin) { fs.closeSync(snapshot.pin.fd); snapshot.pin = null; }
      fs.closeSync(tempFd); tempFd = undefined;
      const replacementStat = tempChain.at(-1).stat;
      fs.renameSync(temp, snapshot.full); tempChain = undefined;
      const saved = openPin(snapshot.full, MAX_SETTINGS_BYTES, digest(bytes), bytes.length);
      try {
        if (!sameNode(saved.pin.before, replacementStat) || saved.pin.before.size !== replacementStat.size) fail();
        observed.set(session.projectId, { full: snapshot.full, digest: saved.pin.digest, stat: saved.pin.before,
          projectChain: snapshot.projectChain, stateChain: snapshot.stateChain });
      } finally { fs.closeSync(saved.pin.fd); }
    } finally {
      if (tempFd !== undefined) fs.closeSync(tempFd);
      if (lockFd !== undefined) fs.closeSync(lockFd);
      // Remove only our own still-direct files; interrupted/stale/foreign files are refused, never reset.
      for (const chain of [tempChain, lockChain]) if (chain) {
        try {
          const currentStat = checkChain(chain).at(-1).stat;
          if (!sameFile(chain.at(-1).stat, currentStat)) fail();
          fs.unlinkSync(chain.at(-1).path);
        } catch { /* Preserve anything whose identity changed. */ }
      }
    }
  }
  async function configure(...args) {
    let snapshot, compiler, ownsDialog = false;
    try {
      if (args.length || smoke || process.platform !== 'win32' || configuring) fail();
      configuring = true; ownsDialog = true;
      const session = current(); snapshot = readSettings(session);
      const selectedCompiler = await dialog.showOpenDialog(session.window, { title: 'Select the approved Luau compiler',
        properties: ['openFile', 'dontAddToRecent'], filters: [{ name: 'Luau compiler', extensions: ['exe'] }] });
      stillCurrent(session); checkSnapshot(snapshot);
      if (selectedCompiler.canceled) return statusValue(session, true);
      if (selectedCompiler.filePaths?.length !== 1) fail();
      const compilerPath = absolute(selectedCompiler.filePaths[0]);
      if (path.basename(compilerPath).toLowerCase() !== 'luau-compile.exe') fail();
      compiler = openPin(compilerPath, COMPILER_BYTES, COMPILER_SHA256, COMPILER_BYTES).pin;
      const selectedEvidence = await dialog.showOpenDialog(session.window, { title: 'Select an existing project evidence folder',
        defaultPath: session.projectPath, properties: ['openDirectory', 'dontAddToRecent'] });
      stillCurrent(session); checkSnapshot(snapshot); checkPin(compiler);
      if (selectedEvidence.canceled) return statusValue(session, true);
      if (selectedEvidence.filePaths?.length !== 1) fail();
      const folder = evidence(session, selectedEvidence.filePaths[0]);
      const settings = settingsTuple({ version: 1, projectId: session.projectId, compilerPath, compilerSha256: COMPILER_SHA256,
        evidenceDirectory: folder.relative }, session.projectId);
      const confirmation = await dialog.showMessageBox(session.window, { type: 'question', title: 'Configure Luau verification',
        message: 'Save this Luau verification configuration for the selected project?',
        detail: 'Compiler: ' + compilerPath + '\nApproved SHA-256: ' + COMPILER_SHA256 + '\nEvidence folder: ' + folder.relative +
          '\n\nApplies after the next manual Arcane restart. Active work and connections continue until you choose to restart Arcane. The compiler is checked by the daemon when configured; verification does not start here.',
        buttons: ['Cancel', 'Save configuration'], defaultId: 0, cancelId: 0, noLink: true });
      stillCurrent(session); checkSnapshot(snapshot); checkPin(compiler); checkChain(folder.chain);
      if (confirmation.response !== 1) return statusValue(session, true);
      persist(session, snapshot, settings);
      return statusValue(session);
    } catch { fail(); }
    finally { if (compiler) fs.closeSync(compiler.fd); if (snapshot?.pin) fs.closeSync(snapshot.pin.fd); if (ownsDialog) configuring = false; }
  }
  function daemonConfiguration(project) {
    let snapshot, compiler;
    try {
      snapshot = readSettings(project);
      if (!snapshot.settings) return { environment: {}, settingsHash: null };
      if (process.platform !== 'win32') fail();
      compiler = openPin(snapshot.settings.compilerPath, COMPILER_BYTES, COMPILER_SHA256, COMPILER_BYTES).pin;
      const folder = evidence(project, path.join(project.projectPath, ...snapshot.settings.evidenceDirectory.split('/')));
      checkSnapshot(snapshot); checkPin(compiler); checkChain(folder.chain);
      return { environment: { ARCANE_LUAU_COMPILER_PATH: snapshot.settings.compilerPath, ARCANE_LUAU_COMPILER_SHA256: COMPILER_SHA256,
        ARCANE_LUAU_EVIDENCE_DIRECTORY: snapshot.settings.evidenceDirectory }, settingsHash: snapshot.hash };
    } catch { fail(); }
    finally { if (compiler) fs.closeSync(compiler.fd); if (snapshot?.pin) fs.closeSync(snapshot.pin.fd); }
  }
  function installIpc(ipcMain) {
    for (const [channel, action] of [['arcane:luau-status', status], ['arcane:luau-configure', configure]]) {
      ipcMain.handle(channel, async (event, ...args) => {
        try {
          const session = current(), contents = session.window.webContents, frame = event.senderFrame;
          if (args.length || event.sender !== contents || !frame || frame !== contents.mainFrame ||
              contents.isDestroyed() || !canonicalFrame(frame.url, session.origin)) fail();
          return await action();
        } catch { fail(); }
      });
    }
  }
  return Object.freeze({ status, configure, daemonConfiguration, installIpc });
}
function canonicalFrame(input, origin) {
  if (!policy.validOrigin(origin) || typeof input !== 'string' || !policy.navigationAllowed(origin, input)) return false;
  try { const url = new URL(input); return url.origin === origin && url.href === input; } catch { return false; }
}
module.exports = { createCodeVerification, COMPILER_SHA256, COMPILER_BYTES, SETTINGS_FILE, ENV_KEYS };
