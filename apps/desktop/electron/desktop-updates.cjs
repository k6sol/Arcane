'use strict';
const { open, lstat } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { join, basename } = require('node:path');
const { pathToFileURL } = require('node:url');
const policy = require('./policy.cjs');
const UNAVAILABLE = 'Updates are unavailable.';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a,b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.nlink === 1 && b.nlink === 1;

async function checkedBytes(file, max) {
  await policy.directPath(file, 'file');
  const before = await lstat(file);
  if (before.size > max) throw Error(UNAVAILABLE);
  const handle = await open(file, 'r');
  try {
    if (!same(before, await handle.stat())) throw Error(UNAVAILABLE);
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) { const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== before.size || !same(before, await handle.stat()) || !same(before, await lstat(file))) throw Error(UNAVAILABLE);
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

async function readInstalledRelease(installRoot, productRoot) {
  const root = await policy.directPath(installRoot);
  try { await lstat(join(root, 'installation.lock')); throw Error(UNAVAILABLE); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const {createWindowsInstallation} = await import(pathToFileURL(join(productRoot, 'scripts/windows-installation.mjs')).href);
  const installed = await createWindowsInstallation().status(root);
  const value = installed.releases.find(release => release.id === installed.activeReleaseId);
  if (!value) throw Error(UNAVAILABLE);
  const directory = await policy.directPath(join(root, 'releases', value.id));
  if (!policy.within(root, directory)) throw Error(UNAVAILABLE);
  const manifest = await checkedBytes(join(directory, 'windows-manifest.json'), 8 * 1024 * 1024);
  if (hash(manifest) !== value.manifestSha256) throw Error(UNAVAILABLE);
  return Object.freeze({ buildId: value.id, manifestSha256: value.manifestSha256, directory,
    executable: await policy.directPath(join(directory, 'Arcane.exe'), 'file') });
}

function createDesktopUpdates(options) {
  const enabled = options.enabled !== false;
  let checking = null, verified = null, restarting = false;
  const unavailable = () => ({ version: 1, state: 'unavailable', buildId: null, message: UNAVAILABLE });
  const verify = options.verifyBundle ?? (async directory => {
    const module = await import(pathToFileURL(join(options.productRoot, 'scripts/windows-installation.mjs')).href);
    return module.verifyInstalledRelease({ installRoot: options.installRoot, expectedReleaseId: basename(directory) });
  });
  async function target() {
    const release = await readInstalledRelease(options.installRoot, options.productRoot);
    const running = hash(await checkedBytes(join(options.currentDirectory, 'windows-manifest.json'), 8 * 1024 * 1024));
    return { release, current: release.manifestSha256 === running };
  }
  async function status() {
    if (!enabled || options.available?.() === false) return unavailable();
    if (checking) return checking;
    checking = (async () => {
      try {
        const { release, current } = await target();
        if (!current && verified !== release.manifestSha256) {
          const proof = await verify(release.directory);
          if (proof.manifestSha256 !== release.manifestSha256) throw Error(UNAVAILABLE);
          verified = release.manifestSha256;
        }
        return { version: 1, state: current ? 'current' : 'available', buildId: release.buildId,
          message: current ? 'Arcane is up to date.' : 'An update is ready. Restart Arcane to use it.' };
      } catch { return unavailable(); }
    })().finally(() => { checking = null; });
    return checking;
  }
  async function restart() {
    if (!enabled || restarting || options.available?.() === false) return { state: 'unavailable', message: UNAVAILABLE };
    restarting = true;
    let accepted = false;
    try {
      const context = options.getContext?.();
      const { release, current } = await target();
      if (current) return { state: 'refused', message: 'Arcane is already up to date.' };
      // Status is a hint; every restart independently revalidates the complete new package.
      const proof = await verify(release.directory);
      const fresh = await readInstalledRelease(options.installRoot, options.productRoot);
      const latestContext = options.getContext?.();
      if (['window', 'epoch', 'origin', 'token'].some(key => context?.[key] !== latestContext?.[key])) throw Error(UNAVAILABLE);
      if (proof.manifestSha256 !== release.manifestSha256 || fresh.manifestSha256 !== release.manifestSha256 || fresh.buildId !== release.buildId || options.available?.() === false)
        throw Error(UNAVAILABLE);
      if (await options.restart(release.executable) !== true) throw Error(UNAVAILABLE);
      accepted = true;
      return { state: 'restarting', message: 'Restarting Arcane…' };
    } catch { return { state: 'refused', message: 'Arcane could not restart safely. Your current window is still open.' }; }
    finally { if (!accepted) restarting = false; }
  }
  function installIpc(ipcMain, { trusted }) {
    for (const [channel, action] of [['arcane:updates-status', status], ['arcane:updates-restart', restart]])
      ipcMain.handle(channel, (event, ...args) => {
        if (args.length || !trusted(event)) throw Error(UNAVAILABLE);
        return action();
      });
  }
  return Object.freeze({ status, restart, installIpc });
}
module.exports = { createDesktopUpdates, readInstalledRelease, checkedBytes };
