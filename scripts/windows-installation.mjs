import * as fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { resolve, parse, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { verifyWindowsBundle } from './package-windows.mjs';

const MANIFEST = 'windows-manifest.json', RECORD = 'installation.json';
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIMITS = Object.freeze({ files: 32768, bytes: 2 * 1024 ** 3, fileBytes: 512 * 1024 ** 2, manifestBytes: 8 * 1024 ** 2, releases: 32 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (a, b) => { const p = relative(a, b); return p === '' || !isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep); };
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a, b) => identity(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
export class WindowsInstallationError extends Error {
  constructor(code, { published = false, stagingDirectory = null, cause } = {}) {
    super('Arcane installation ' + code + '. ' + (published === null ? 'Publication could not be confirmed; inspect the retained installation state.' : published ? 'The new release record was published; inspect the retained installation state.' : 'The previous release selection was retained.'), { cause });
    this.name = 'WindowsInstallationError'; this.code = code; this.published = published; this.stagingDirectory = stagingDirectory;
  }
}
const fail = code => { throw new WindowsInstallationError(code); };
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('RECORD');
}
function absolute(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value !== value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) ||
      process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value)) fail('PATH');
  const path = resolve(value); if (path === parse(path).root) fail('PATH'); return path;
}
/** Canonical resolution fences ancestor redirects; lstat also checks the leaf's kind and link count. */
async function direct(path, kind = 'directory') {
  const full = absolute(path), stat = await fs.lstat(full, { bigint: true });
  if (stat.isSymbolicLink() || !equalPath(await fs.realpath(full), full)) fail('REDIRECT');
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) fail('PATH');
  return stat;
}
async function bounded(path, maximum) {
  const before = await direct(path, 'file'); if (before.size > BigInt(maximum)) fail('SIZE');
  const handle = await fs.open(path, 'r');
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) fail('CHANGED');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== Number(before.size) || !sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await direct(path, 'file'))) fail('CHANGED');
    return { bytes: bytes.subarray(0, offset), stat: before };
  } finally { await handle.close(); }
}
function readJson(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('JSON'); } }
function inventory(bytes, proof) {
  const manifest = readJson(bytes), paths = new Set();
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'arcane-windows-directory' || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      typeof manifest.version !== 'string' || manifest.version.length > 64 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version) ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > LIMITS.files || manifest.fileCount !== manifest.files.length ||
      proof.manifestSha256 !== digest(bytes) || proof.files !== manifest.fileCount || proof.bytes !== manifest.totalBytes) fail('MANIFEST');
  let total = 0;
  for (const file of manifest.files) {
    exact(file, ['path', 'bytes', 'sha256']);
    if (typeof file.path !== 'string' || file.path.length > 1024 || file.path === MANIFEST || /[\\:\x00-\x1f\x7f<>"|?*]/.test(file.path) ||
        file.path.split('/').length > 32 || file.path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
        paths.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > LIMITS.fileBytes || typeof file.sha256 !== 'string' || !HASH.test(file.sha256)) fail('MANIFEST');
    paths.add(file.path.toLowerCase()); total += file.bytes;
    if (total > LIMITS.bytes) fail('SIZE');
  }
  if (total !== manifest.totalBytes || !paths.has('arcane.exe') || !paths.has('resources/node/node.exe')) fail('MANIFEST');
  return manifest;
}
function installation(value) {
  exact(value, ['schemaVersion', 'kind', 'installationId', 'activeReleaseId', 'releases']);
  if (value.schemaVersion !== 1 || value.kind !== 'arcane-windows-installation' || typeof value.installationId !== 'string' || !UUID.test(value.installationId) ||
      !Array.isArray(value.releases) || value.releases.length > LIMITS.releases) fail('RECORD');
  const ids = new Set();
  for (const entry of value.releases) {
    exact(entry, ['id', 'version', 'manifestSha256', 'files', 'bytes', 'installedAt']);
    if (typeof entry.id !== 'string' || entry.id.length !== 101 || !UUID.test(entry.id.slice(65)) || ids.has(entry.id) || typeof entry.manifestSha256 !== 'string' || !HASH.test(entry.manifestSha256) ||
        !entry.id.startsWith(entry.manifestSha256 + '-') || typeof entry.version !== 'string' || entry.version.length > 64 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(entry.version) ||
        !Number.isSafeInteger(entry.files) || entry.files < 1 || entry.files > LIMITS.files || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > LIMITS.bytes ||
        typeof entry.installedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.installedAt) || !Number.isFinite(Date.parse(entry.installedAt))) fail('RECORD');
    ids.add(entry.id);
  }
  if (!(value.activeReleaseId === null && ids.size === 0 || typeof value.activeReleaseId === 'string' && ids.has(value.activeReleaseId))) fail('RECORD');
  return value;
}
async function writeExclusive(path, bytes) {
  const handle = await fs.open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); return await handle.stat({ bigint: true }); } finally { await handle.close(); }
}
async function hashFile(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
function treeFence(root, directories, files, assertScope) {
  const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
  return async () => {
    const expected = new Set([...directories.keys(), ...files.keys()].map(key));
    await assertScope();
    for (const [path, original] of directories) if (!identity(original, await direct(path))) fail('CHANGED');
    for (const [path, original] of files) if (!sameFile(original, await direct(path, 'file'))) fail('CHANGED');
    let seen = 1;
    const walk = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (!expected.has(key(path)) || entry.isSymbolicLink() || ++seen > expected.size) fail('CHANGED');
        if (entry.isDirectory()) await walk(path);
        else if (!entry.isFile()) fail('CHANGED');
      }
    };
    await walk(root);
    if (seen !== expected.size) fail('CHANGED');
    await assertScope();
  };
}

/** Host/build API only. The verifier seam is for owned fixtures; customer entrypoints use the default full bundle verifier. */
export function createWindowsInstallation({ verifyBundle = verifyWindowsBundle } = {}) {
  if (typeof verifyBundle !== 'function') fail('INPUT');
  async function status(installRoot) {
    const root = absolute(installRoot); await direct(root);
    const record = installation(readJson((await bounded(join(root, RECORD), 65536)).bytes));
    return Object.freeze({ installationId: record.installationId, activeReleaseId: record.activeReleaseId, integrityVerified: false,
      releases: Object.freeze(record.releases.map(entry => Object.freeze({ ...entry }))), root });
  }
  async function install({ bundle, installRoot, signal, onProgress }) {
    if (signal !== undefined && !(signal instanceof AbortSignal) || onProgress !== undefined && typeof onProgress !== 'function') fail('INPUT');
    let filesCopied = 0, bytesCopied = 0, totalFiles = 0, totalBytes = 0;
    const cancelled = () => { if (signal?.aborted) fail('CANCELLED'); };
    const progress = phase => {
      if (!onProgress) return;
      const value = onProgress(Object.freeze({ phase, filesCopied, totalFiles, bytesCopied, totalBytes }));
      if (value !== undefined) { if (types.isPromise(value)) void Promise.prototype.catch.call(value, () => {}); fail('PROGRESS'); }
    };
    cancelled();
    const source = absolute(bundle), root = absolute(installRoot);
    if (within(source, root) || within(root, source)) fail('OVERLAP');
    // CreateProcessW still bounds a child's current directory even when Node
    // can copy longer paths. Reserve the complete release and runtime path
    // before creating installation metadata or publishing an unusable release.
    if (process.platform === 'win32' && join(root, 'releases', '0'.repeat(101), 'resources/node/node.exe').length > 259) fail('PATH_LENGTH');
    await direct(source); await direct(dirname(root));
    // Full source acceptance precedes any installation mutation.
    progress('verifying-source'); cancelled();
    const sourceProof = await verifyBundle(source), sourceManifest = await bounded(join(source, MANIFEST), LIMITS.manifestBytes);
    const manifest = inventory(sourceManifest.bytes, sourceProof), manifestSha256 = digest(sourceManifest.bytes);
    totalFiles = manifest.fileCount + 1; totalBytes = manifest.totalBytes + sourceManifest.bytes.length; cancelled();
    let rootStat;
    try { rootStat = await direct(root); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(root, { mode: 0o700 }); rootStat = await direct(root); }
    const recordPath = join(root, RECORD);
    try { await direct(recordPath, 'file'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if ((await fs.readdir(root)).length) fail('UNOWNED');
      const initial = { schemaVersion: 1, kind: 'arcane-windows-installation', installationId: randomUUID(), activeReleaseId: null, releases: [] };
      await writeExclusive(recordPath, Buffer.from(JSON.stringify(initial) + '\n'));
    }
    const lockPath = join(root, 'installation.lock'); let lock, lockStat, assertLock = null, published = false, publishing = false, stagingDirectory = null, primaryError = null;
    try {
      lock = await fs.open(lockPath, 'wx+', 0o600);
      const lockBytes = Buffer.from(JSON.stringify({ installationOperation: randomUUID(), sourceManifestSha256: manifestSha256 }) + '\n');
      await lock.writeFile(lockBytes); await lock.sync(); lockStat = await lock.stat({ bigint: true });
      assertLock = async () => {
        if (!sameFile(lockStat, await direct(lockPath, 'file')) || !sameFile(lockStat, await lock.stat({ bigint: true }))) fail('CHANGED');
        const observed = Buffer.alloc(lockBytes.length + 1);
        const { bytesRead } = await lock.read(observed, 0, observed.length, 0);
        if (bytesRead !== lockBytes.length || !observed.subarray(0, bytesRead).equals(lockBytes) || !sameFile(lockStat, await lock.stat({ bigint: true }))) fail('CHANGED');
      };
      const assertRoot = async () => {
        cancelled();
        if (!identity(rootStat, await direct(root))) fail('CHANGED');
        await assertLock();
      };
      await assertRoot();
      const observed = await bounded(recordPath, 65536), record = installation(readJson(observed.bytes));
      const releasesRoot = join(root, 'releases');
      try { await direct(releasesRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; if (record.releases.length) fail('RELEASE_MISSING'); await fs.mkdir(releasesRoot, { mode: 0o700 }); }
      const releasesStat = await direct(releasesRoot);
      const assertCurrent = async () => {
        await assertRoot();
        if (!identity(releasesStat, await direct(releasesRoot)) || !sameFile(observed.stat, await direct(recordPath, 'file')) || digest((await bounded(recordPath, 65536)).bytes) !== digest(observed.bytes)) fail('CHANGED');
      };
      const recorded = record.releases.find(entry => entry.manifestSha256 === manifestSha256);
      // A recorded release whose ENTIRE directory is genuinely absent (ENOENT beneath the same real releases parent) is
      // repaired from this fully verified bundle into a NEW exclusive release id that replaces only that record entry.
      // The missing id's path is never recreated, reused or adopted; any present, partial, changed or redirected target
      // keeps the existing verification and its refusals.
      const absentPath = async id => {
        try { await fs.lstat(join(releasesRoot, id)); return false; }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
      };
      let absent = null;
      if (recorded) { await assertCurrent(); if (await absentPath(recorded.id)) { await assertCurrent(); absent = recorded; } }
      const existing = absent ? undefined : recorded;
      let entry = existing;
      let assertCopied = async () => {};
      if (entry) {
        const directory = join(releasesRoot, entry.id), directories = new Map([[directory, await direct(directory)]]), files = new Map();
        for (const item of [...manifest.files, { path: MANIFEST }]) {
          let parent = directory;
          for (const component of item.path.split('/').slice(0, -1)) { parent = join(parent, component); if (!directories.has(parent)) directories.set(parent, await direct(parent)); }
          const path = join(directory, ...item.path.split('/')); files.set(path, await direct(path, 'file'));
        }
        assertCopied = treeFence(directory, directories, files, assertCurrent);
        const proof = await verifyBundle(directory); await assertCopied();
        if (proof.manifestSha256 !== manifestSha256 || proof.files !== entry.files || proof.bytes !== entry.bytes || entry.version !== manifest.version) fail('RELEASE_CHANGED');
      } else {
        // Replacing an absent recorded slot keeps the entry count unchanged.
        if (!absent && record.releases.length >= LIMITS.releases) fail('RETENTION');
        entry = { id: manifestSha256 + '-' + randomUUID(), version: manifest.version, manifestSha256, files: sourceProof.files, bytes: sourceProof.bytes, installedAt: new Date().toISOString() };
        stagingDirectory = join(releasesRoot, entry.id);
        await assertCurrent(); await fs.mkdir(stagingDirectory, { mode: 0o700 }); const stageStat = await direct(stagingDirectory);
        const assertStage = async () => { await assertRoot(); if (!identity(releasesStat, await direct(releasesRoot)) || !identity(stageStat, await direct(stagingDirectory))) fail('CHANGED'); };
        const directories = new Map([[stagingDirectory, stageStat]]), files = new Map();
        assertCopied = treeFence(stagingDirectory, directories, files, assertStage);
        progress('copying');
        for (const item of [...manifest.files, { path: MANIFEST, bytes: sourceManifest.bytes.length, sha256: manifestSha256 }]) {
          await assertStage();
          const from = join(source, ...item.path.split('/')), to = join(stagingDirectory, ...item.path.split('/'));
          const before = await direct(from, 'file');
          if (before.size !== BigInt(item.bytes)) fail('SOURCE_CHANGED');
          let directory = stagingDirectory;
          for (const component of item.path.split('/').slice(0, -1)) {
            directory = join(directory, component);
            try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
            const stat = await direct(directory), original = directories.get(directory);
            if (original && !identity(original, stat)) fail('CHANGED');
            directories.set(directory, stat);
          }
          await assertStage(); await direct(dirname(to));
          await fs.copyFile(from, to, constants.COPYFILE_EXCL);
          const copiedStat = await direct(to, 'file');
          if (!sameFile(before, await direct(from, 'file')) || await hashFile(to) !== item.sha256 || !sameFile(copiedStat, await direct(to, 'file'))) fail('SOURCE_CHANGED');
          files.set(to, copiedStat);
          await assertStage();
          filesCopied++; bytesCopied += item.bytes; progress('copying');
        }
        cancelled(); progress('verifying-copy');
        const copied = await verifyBundle(stagingDirectory); await assertCopied();
        if (copied.manifestSha256 !== manifestSha256 || copied.files !== sourceProof.files || copied.bytes !== sourceProof.bytes) fail('COPY');
      }
      await assertCurrent(); await assertCopied();
      if (record.activeReleaseId !== entry.id) {
        const next = { ...record, activeReleaseId: entry.id,
          releases: existing ? record.releases : absent ? record.releases.map(item => item.id === absent.id ? entry : item) : [...record.releases, entry] };
        const temporary = join(root, 'installation-' + randomUUID() + '.json');
        const temporaryStat = await writeExclusive(temporary, Buffer.from(JSON.stringify(next) + '\n'));
        await assertCurrent(); await assertCopied();
        if (!sameFile(temporaryStat, await direct(temporary, 'file'))) fail('CHANGED');
        progress('publishing'); await assertCurrent(); await assertCopied();
        // The replaced slot must still be absent at the publication boundary; anything that appeared there is kept untouched (existing RELEASE_CHANGED code).
        if (absent && !await absentPath(absent.id)) fail('RELEASE_CHANGED');
        // ENOENT can also mean the parent moved during that await. Rebind the namespace and candidate before publication.
        if (absent) { await assertCurrent(); await assertCopied(); }
        publishing = true; await fs.rename(temporary, recordPath); published = true;
        if (digest((await bounded(recordPath, 65536)).bytes) !== digest(Buffer.from(JSON.stringify(next) + '\n'))) fail('PUBLISH_UNCONFIRMED');
      }
      const state = existing && record.activeReleaseId === entry.id ? 'already-active' : 'installed'; progress(state);
      return Object.freeze({ state, installationId: record.installationId,
        activeReleaseId: entry.id, previousReleaseId: record.activeReleaseId, releaseDirectory: join(releasesRoot, entry.id), manifestSha256,
        files: entry.files, bytes: entry.bytes, repairedReleaseId: absent ? absent.id : null, previousReleasesRetained: true, launched: false, registration: false, shortcuts: false, signed: false });
    } catch (error) {
      primaryError = error instanceof WindowsInstallationError && !published && !stagingDirectory ? error :
        new WindowsInstallationError(error.code === 'EEXIST' && !lock ? 'LOCKED' : error instanceof WindowsInstallationError ? error.code : 'IO', { cause: error, published: published ? true : publishing ? null : false, stagingDirectory });
      throw primaryError;
    } finally {
      if (lock) {
        let closed = false;
        try {
          if (!assertLock) fail('LOCK_UNCONFIRMED');
          await assertLock(); await lock.close(); closed = true;
          const current = await direct(lockPath, 'file');
          if (!sameFile(lockStat, current)) fail('LOCK_CHANGED');
          await fs.unlink(lockPath);
        } catch (cleanupError) {
          if (!closed) { try { await lock.close(); } catch { /* Retain the primary cleanup outcome. */ } }
          if (primaryError) primaryError.cleanup = Object.freeze({ state: 'retained', code: cleanupError.code ?? 'IO' });
          else throw new WindowsInstallationError('LOCK_CHANGED', { published, stagingDirectory, cause: cleanupError });
        }
      }
    }
  }
  return Object.freeze({ install, status });
}

export const WINDOWS_INSTALLATION_LIMITS = LIMITS;
