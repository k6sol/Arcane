'use strict';
// Presentation preferences only. No provider credentials, grants, paths or native authority.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { types } = require('node:util');
const policy = require('./policy.cjs');
const FILE = 'workspace-preferences.v1.json';
const MAX_TABS = 16, MAX_FILE_BYTES = 1024 * 1024, MAX_PLAIN_BYTES = 512 * 1024;
const ERROR = 'Arcane workspace preferences are unavailable.';
const ROW_FIELDS = Object.freeze(['localId', 'title', 'provider', 'threadId', 'sessionId', 'draft', 'modelId', 'effort', 'tool', 'previewOpen']);
const fail = () => { throw new Error(ERROR); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameNode = (a, b) => ['dev', 'ino', 'mode', 'nlink'].every(key => a[key] === b[key]);
const sameFile = (a, b) => sameNode(a, b) && ['size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

function fields(value, names) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== names.length || names.some(name => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) fail();
  return value;
}
function text(value, max, identifier = false) {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || Buffer.byteLength(value) > max ||
      (identifier && (!/^[A-Za-z0-9]/.test(value) || /[^A-Za-z0-9._:-]/.test(value)))) fail();
  return value;
}
function nullableId(value, max) { return value === null ? null : text(value, max, true); }
function presentationModel(value) {
  if (value === null) return null;
  const model = text(value, 256);
  if (!model.length || model.trim() !== model || /[\x00-\x1f\x7f]/.test(model)) fail();
  return model;
}
function preferences(value, scope, claude = false) {
  fields(value, ['version', 'projectPath', 'provider', 'tabs', 'activeTabId']);
  // Advisory comparison only. Never derive a path, project identity or authority from renderer data.
  const projectPath = text(value.projectPath, 4096);
  if (typeof scope.projectPath !== 'string' || !samePath(projectPath, scope.projectPath)) fail();
  if (value.version !== 1 || !['codex', 'claude'].includes(value.provider) ||
      types.isProxy(value.tabs) || !Array.isArray(value.tabs) || Object.getPrototypeOf(value.tabs) !== Array.prototype ||
      value.tabs.length > MAX_TABS || Reflect.ownKeys(value.tabs).length !== value.tabs.length + 1) fail();
  const tabs = [], ids = new Set();
  for (let i = 0; i < value.tabs.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value.tabs, String(i));
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) fail();
    // Optional boolean workflowDraft keeps a workflow draft's review gate across restarts. Legacy rows omit it and mean a
    // plain draft (false); presence is preserved exactly so canonical legacy records still decrypt and read back unchanged.
    const flagged = !!d.value && !types.isProxy(d.value) && Object.getPrototypeOf(d.value) === Object.prototype && Object.hasOwn(d.value, 'workflowDraft');
    const row = fields(d.value, flagged ? [...ROW_FIELDS, 'workflowDraft'] : ROW_FIELDS);
    if (flagged && typeof row.workflowDraft !== 'boolean') fail();
    const localId = text(row.localId, 128, true), title = text(row.title, 512);
    if (ids.has(localId) || /[\x00-\x1f\x7f]/.test(title) || !['codex', 'claude'].includes(row.provider) ||
        !['all', 'blender', 'roblox'].includes(row.tool) || typeof row.previewOpen !== 'boolean') fail();
    ids.add(localId);
    tabs.push({ localId, title, provider: row.provider, threadId: nullableId(row.threadId, 256), sessionId: nullableId(row.sessionId, 256),
      draft: text(row.draft, 128 * 1024), modelId: claude ? presentationModel(row.modelId) : nullableId(row.modelId, 256), effort: nullableId(row.effort, 64),
      tool: row.tool, previewOpen: row.previewOpen, ...(flagged ? { workflowDraft: row.workflowDraft } : {}) });
  }
  const activeTabId = nullableId(value.activeTabId, 128);
  if (activeTabId !== null && !ids.has(activeTabId)) fail();
  const result = { version: 1, projectPath, provider: value.provider, tabs, activeTabId };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_PLAIN_BYTES) fail();
  return result;
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

function createWorkspacePreferences({ safeStorage, getSession, enabled = true, record = 'workspace' }) {
  if (record !== 'workspace' && record !== 'claude') fail();
  const recordFile = record === 'claude' ? 'claude-preferences.v1.json' : FILE;
  const recordChannel = record === 'claude' ? 'arcane:claude-preferences-' : 'arcane:workspace-preferences-';
  function recordPreferences(value, scope) {
    const parsed = preferences(value, scope, record === 'claude');
    if (record === 'claude' && (parsed.provider !== 'claude' || parsed.tabs.some(row => row.provider !== 'claude' || row.sessionId !== null || row.tool !== 'all' || row.previewOpen !== false || Object.hasOwn(row, 'workflowDraft')))) fail();
    return parsed;
  }
  // Construction/install are inert, including in smoke mode. All reads are gated IPC intents.
  let busy = false, tourBusy = false, checklistBusy = false;
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
    if (typeof scope.projectPath !== 'string' || typeof scope.userRoot !== 'string' || typeof scope.stateRoot !== 'string' ||
        typeof scope.projectId !== 'string' || !/^[a-f0-9]{64}$/.test(scope.projectId) ||
        hash(scope.projectPath.toLowerCase()) !== scope.projectId ||
        !samePath(scope.stateRoot, path.join(scope.userRoot, 'runtime', 'projects', scope.projectId))) fail();
    const projectChain = checkedPath(scope.projectPath), stateChain = checkedPath(scope.stateRoot);
    // The full profile/state parent chain is pinned by checkedPath; no directories are created here.
    const full = path.join(scope.stateRoot, recordFile);
    if (!policy.within(scope.stateRoot, full)) fail();
    return { full, projectChain, stateChain };
  }
  function checkSnapshot(snapshot) {
    checkChain(snapshot.projectChain); checkChain(snapshot.stateChain);
    if (snapshot.pin) checkPin(snapshot.pin); else if (!missing(snapshot.full)) fail();
  }
  function payload(value, scope) {
    fields(value, record === 'claude' ? ['version', 'projectId', 'record', 'preferences'] : ['version', 'projectId', 'preferences']);
    if (value.version !== 1 || value.projectId !== scope.projectId || record === 'claude' && value.record !== 'claude') fail();
    return { version: 1, projectId: value.projectId, ...(record === 'claude' ? { record: 'claude' } : {}), preferences: recordPreferences(value.preferences, scope) };
  }
  function unlocked(snapshot) { if (!missing(snapshot.full + '.lock')) fail(); }
  function readSnapshot(scope, event, paths) {
    const snapshot = { ...paths };
    checkChain(snapshot.projectChain); checkChain(snapshot.stateChain);
    guard(scope, event); unlocked(snapshot);
    if (missing(snapshot.full)) return { ...snapshot, preferences: null, pin: null };
    const { pin, bytes } = openPin(snapshot.full); snapshot.pin = pin;
    try {
      const envelope = fields(JSON.parse(bytes.toString('utf8')), ['version', 'ciphertext']);
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || !envelope.ciphertext ||
          !bytes.equals(Buffer.from(JSON.stringify(envelope) + '\n'))) fail();
      const encrypted = Buffer.from(envelope.ciphertext, 'base64');
      if (!encrypted.length || encrypted.length > MAX_FILE_BYTES || encrypted.toString('base64') !== envelope.ciphertext) fail();
      guard(scope, event); checkSnapshot(snapshot); unlocked(snapshot); if (!available()) fail();
      const plain = safeStorage.decryptString(encrypted);
      guard(scope, event); checkSnapshot(snapshot); unlocked(snapshot); if (!available()) fail();
      if (typeof plain !== 'string' || Buffer.byteLength(plain) > MAX_PLAIN_BYTES) fail();
      const decoded = payload(JSON.parse(plain), scope);
      if (JSON.stringify(decoded) !== plain) fail();
      return { ...snapshot, preferences: { ...decoded.preferences, projectPath: scope.projectPath } };
    } catch (error) { fs.closeSync(pin.fd); throw error; }
  }
  function persist(scope, event, snapshot, input) {
    // Presentation data and the host's project identity are sealed together.
    const plain = JSON.stringify(payload({ version: 1, projectId: scope.projectId, ...(record === 'claude' ? { record: 'claude' } : {}), preferences: input }, scope));
    if (Buffer.byteLength(plain) > MAX_PLAIN_BYTES) fail();
    guard(scope, event); checkSnapshot(snapshot); unlocked(snapshot); if (!available()) fail();
    const encrypted = safeStorage.encryptString(plain);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_FILE_BYTES) fail();
    const bytes = Buffer.from(JSON.stringify({ version: 1, ciphertext: encrypted.toString('base64') }) + '\n');
    if (bytes.length > MAX_FILE_BYTES) fail();
    persistBytes(scope, event, snapshot, bytes);
  }
  function persistBytes(scope, event, snapshot, bytes) {
    const lock = snapshot.full + '.lock', temp = snapshot.full + '.' + randomUUID() + '.tmp';
    let lockFd, tempFd, lockChain, tempChain, savedIdentity;
    try {
      guard(scope, event); checkSnapshot(snapshot);
      lockFd = fs.openSync(lock, 'wx+', 0o600);
      const createdLock = checkedPath(lock, 'file');
      if (!sameFile(createdLock.at(-1).stat, fs.fstatSync(lockFd, { bigint: true }))) fail();
      lockChain = createdLock;
      guard(scope, event); checkSnapshot(snapshot);
      tempFd = fs.openSync(temp, 'wx+', 0o600);
      const createdStage = checkedPath(temp, 'file');
      if (!sameFile(createdStage.at(-1).stat, fs.fstatSync(tempFd, { bigint: true }))) fail();
      tempChain = createdStage;
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(tempFd, bytes, written, bytes.length - written);
        if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - written) fail();
        written += count;
      }
      fs.fsyncSync(tempFd);
      const flushedStage = checkChain(tempChain);
      if (!sameFile(flushedStage.at(-1).stat, fs.fstatSync(tempFd, { bigint: true })) || !readBounded(tempFd).equals(bytes)) fail();
      tempChain = flushedStage;
      if (!available()) fail(); guard(scope, event); checkSnapshot(snapshot);
      const lockStat = checkChain(lockChain).at(-1).stat;
      if (!sameFile(lockChain.at(-1).stat, lockStat) || !sameFile(lockStat, fs.fstatSync(lockFd, { bigint: true }))) fail();
      checkChain(tempChain);
      if (!sameFile(tempChain.at(-1).stat, fs.fstatSync(tempFd, { bigint: true }))) fail();
      // Close handles for Windows rename; never truncate/unlink the previous record.
      const previousPin = snapshot.pin;
      if (previousPin) { fs.closeSync(previousPin.fd); snapshot.pin = null; }
      fs.closeSync(tempFd); tempFd = undefined;
      guard(scope, event); checkChain(snapshot.projectChain); checkChain(snapshot.stateChain);
      if (previousPin) {
        if (!sameFile(previousPin.before, checkChain(previousPin.chain).at(-1).stat)) fail();
      } else if (!missing(snapshot.full)) fail();
      const stagedStat = tempChain.at(-1).stat;
      if (!sameFile(stagedStat, checkChain(tempChain).at(-1).stat) ||
          !sameFile(lockChain.at(-1).stat, checkChain(lockChain).at(-1).stat) ||
          !sameFile(lockChain.at(-1).stat, fs.fstatSync(lockFd, { bigint: true }))) fail();
      fs.renameSync(temp, snapshot.full); tempChain = undefined;
      savedIdentity = stagedStat;
      const saved = openPin(snapshot.full);
      try {
        if (!sameNode(saved.pin.before, stagedStat) || !saved.bytes.equals(bytes)) fail();
        guard(scope, event); checkChain(snapshot.projectChain); checkChain(snapshot.stateChain); if (!available()) fail();
      } finally { fs.closeSync(saved.pin.fd); }
    } finally {
      if (tempFd !== undefined) {
        // Pin our partial write before closing so a failed flush can clean up its own stage.
        try {
          const after = checkChain(tempChain), stat = fs.fstatSync(tempFd, { bigint: true });
          if (!sameNode(tempChain.at(-1).stat, stat) || !sameFile(after.at(-1).stat, stat)) fail();
          tempChain = after;
        } catch { tempChain = undefined; /* A changed/redirected stage remains untouched. */ }
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
    // A failed/foreign lock cleanup or a changed record must never produce a saved acknowledgement.
    guard(scope, event); checkChain(snapshot.projectChain); checkChain(snapshot.stateChain); unlocked(snapshot);
    if (!available()) fail();
    const confirmed = openPin(snapshot.full);
    try {
      if (!sameNode(savedIdentity, confirmed.pin.before) || !confirmed.bytes.equals(bytes)) fail();
      guard(scope, event); checkChain(snapshot.projectChain); checkChain(snapshot.stateChain); unlocked(snapshot);
    } finally { fs.closeSync(confirmed.pin.fd); }
  }
  function installIpc(ipcMain) {
    if (record === 'workspace') {
    for (const action of ['read', 'save']) {
      ipcMain.handle('arcane:setup-checklist-' + action, async (event, ...args) => {
        let snapshot, ownsBusy = false;
        const memory = value => {
          fields(value, ['version', 'completed', 'dismissed']);
          if (value.version !== 1 || typeof value.completed !== 'boolean' || typeof value.dismissed !== 'boolean') fail();
          return { version: 1, completed: value.completed, dismissed: value.dismissed };
        };
        try {
          const scope = current(event);
          if (action === 'read' ? args.length !== 0 : args.length !== 1) fail();
          const input = action === 'save' ? memory(args[0]) : null;
          if (checklistBusy) fail(); checklistBusy = true; ownsBusy = true;
          if (!available()) { if (action === 'read') return { available: false, memory: null }; fail(); }
          const chain = checkedPath(scope.userRoot);
          snapshot = { full: path.join(scope.userRoot, 'setup-checklist.v1.json'), projectChain: chain, stateChain: chain, pin: null };
          guard(scope, event); checkChain(chain); unlocked(snapshot);
          let saved = null, previousBytes = null;
          if (!missing(snapshot.full)) {
            const opened = openPin(snapshot.full); snapshot.pin = opened.pin; previousBytes = opened.bytes;
            if (previousBytes.length > 128) fail();
            saved = memory(JSON.parse(previousBytes.toString('utf8')));
            if (!previousBytes.equals(Buffer.from(JSON.stringify(saved) + '\n'))) fail();
          }
          guard(scope, event); checkSnapshot(snapshot); unlocked(snapshot);
          if (action === 'read') return { available: true, memory: saved };
          const bytes = Buffer.from(JSON.stringify(input) + '\n');
          if (!previousBytes?.equals(bytes)) persistBytes(scope, event, snapshot, bytes);
          return { saved: true };
        } catch { fail(); }
        finally { try { if (snapshot?.pin) fs.closeSync(snapshot.pin.fd); } finally { if (ownsBusy) checklistBusy = false; } }
      });
    }
    // One non-secret app-wide flag, independent of project, daemon port and the temporary browser partition.
    for (const action of ['read', 'dismiss']) {
      ipcMain.handle('arcane:welcome-tour-' + action, async (event, ...args) => {
        let snapshot, ownsBusy = false;
        try {
          const scope = current(event);
          if (action === 'read') { if (args.length) fail(); }
          else if (args.length !== 1 || !['finished', 'skipped'].includes(fields(args[0], ['how']).how)) fail();
          if (tourBusy) fail(); tourBusy = true; ownsBusy = true;
          if (!available()) { if (action === 'read') return { available: false, seen: false }; fail(); }
          const chain = checkedPath(scope.userRoot);
          snapshot = { full: path.join(scope.userRoot, 'welcome-tour.v1.json'), projectChain: chain, stateChain: chain, pin: null };
          guard(scope, event); checkChain(chain); unlocked(snapshot);
          const bytes = Buffer.from('{"version":1,"seen":true}\n');
          let seen = false;
          if (!missing(snapshot.full)) {
            const opened = openPin(snapshot.full); snapshot.pin = opened.pin;
            if (!opened.bytes.equals(bytes)) fail();
            seen = true;
          }
          guard(scope, event); checkSnapshot(snapshot); unlocked(snapshot);
          if (action === 'read') return { available: true, seen };
          if (!seen) persistBytes(scope, event, snapshot, bytes);
          return { saved: true };
        } catch { fail(); }
        finally { try { if (snapshot?.pin) fs.closeSync(snapshot.pin.fd); } finally { if (ownsBusy) tourBusy = false; } }
      });
    }
    }
    for (const action of ['read', 'save']) {
      ipcMain.handle(recordChannel + action, async (event, ...args) => {
        let ownsBusy = false, snapshot;
        try {
          const scope = current(event);
          let input;
          if (action === 'read') { if (args.length) fail(); }
          else {
            if (args.length !== 1) fail();
            input = { ...recordPreferences(args[0], scope), projectPath: scope.projectPath };
          }
          if (busy) fail(); busy = true; ownsBusy = true;
          const usable = available(); guard(scope, event);
          if (!usable) { if (action === 'read') return { available: false, ...(record === 'claude' ? { projectPath: null } : {}), preferences: null }; fail(); }
          const paths = projectScope(scope);
          // Pin paths before yielding; recheck owner/main frame/project/origin before access.
          await Promise.resolve(); guard(scope, event);
          if (!available()) fail(); guard(scope, event);
          snapshot = readSnapshot(scope, event, paths); guard(scope, event); checkSnapshot(snapshot); unlocked(snapshot);
          if (action === 'read') return { available: true, ...(record === 'claude' ? { projectPath: scope.projectPath } : {}), preferences: snapshot.preferences };
          persist(scope, event, snapshot, input); guard(scope, event);
          return { saved: true };
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
module.exports = { createWorkspacePreferences };
