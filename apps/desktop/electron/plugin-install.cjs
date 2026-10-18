'use strict';

// Main-process host for one-click Studio plugin install and update. It copies only the bundled, manifest-verified
// plugin build into Roblox Studio's local Plugins folder (temp file + rename), after a native confirm dialog.
// The plugin file never carries keys, tickets or session links: after install Arcane opens a short-lived one-click
// pairing offer (docs/studio-pairing.md); the Arcane API key flow remains the fallback.
// Import and construction have no native side effects; reading status never writes anything.
const nativeFs = require('node:fs/promises');
const nativePath = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const ARTIFACT = 'ArcaneLocalBridge.rbxmx';
const LEGACY = Object.freeze(['ArcaneLocalBridge.lua', 'ArcaneLocalBridge.rbxm']);
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024, MAX_MANIFEST_BYTES = 1024 * 1024;
const STATES = Object.freeze(['installed', 'outdated', 'missing', 'unavailable']);
const VERSION = /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/;
const SHA256 = /^[a-f0-9]{64}$/;
// Fixed renderer-safe text. Native paths and errors never reach the renderer.
const MESSAGES = Object.freeze({
  installed: 'The Arcane Studio plugin is installed and current.',
  outdated: 'An older Arcane Studio plugin is installed. Update it to match this app.',
  missing: 'The Arcane Studio plugin is not installed yet.',
  updated: 'Arcane Studio plugin installed. Restart Roblox Studio to load it.',
  current: 'The Arcane Studio plugin is already current.',
  cancelled: 'Plugin install cancelled. Nothing was changed.',
  disabled: 'Studio plugin setup is disabled in verification mode.',
  platform: 'One-click plugin install is available on Windows.',
  folder: 'The Roblox Studio Plugins folder could not be found.',
  bundle: 'The bundled Arcane plugin failed its integrity check. Reinstall Arcane, then try again.',
  foreign: 'Another plugin already uses the Arcane plugin file name. Remove or rename it, then try again.',
  unavailable: 'Studio plugin setup is unavailable.',
  busy: 'A plugin install is already running.',
  changed: 'The plugin folder changed during install. Nothing was overwritten; try again.',
});
// Credential material that must never be written into a Studio plugin file.
const CREDENTIAL_PATTERNS = Object.freeze([
  /arcane_local_v1_[0-9]+_[a-f0-9]{64}/i,
  /arcane_pair_v1_[0-9]+_[a-f0-9]{48}/i,
  /127\.0\.0\.1:[0-9]+\/(?:studio)?#[a-f0-9]{64}/i,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (message, code = 'ARCANE_PLUGIN') => Object.assign(new Error(message), { code, safe: true });

/** True when bytes carry an Arcane API key, a loopback session link or private key material. */
function containsCredential(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  return CREDENTIAL_PATTERNS.some(pattern => pattern.test(text));
}
function ownedPluginText(text, filename) {
  return filename.endsWith('.lua')
    ? text.startsWith('--!strict') && text.includes('local __arcaneFactories')
    : text.startsWith('<?xml ') && text.includes('<string name="Name">ArcaneLocalBridge</string>');
}

/**
 * createStudioPluginInstaller({ productRoot, pluginsDirectory?, localAppData?, backupDirectory, platform?, enabled?, confirm, fs? })
 * Every path option may be a value or a zero-argument getter so the host can bind late (after app ready).
 */
function createStudioPluginInstaller(options = {}) {
  const fs = options.fs ?? nativeFs, path = nativePath;
  const read = value => typeof value === 'function' ? value() : value;
  const platform = options.platform ?? process.platform;
  const enabled = options.enabled !== false;
  let busy = false;

  async function noLinks(target) {
    for (let current = path.resolve(target); ;) {
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw failure(MESSAGES.folder); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(current); if (parent === current) return; current = parent;
    }
  }
  async function boundedFile(file, max) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw failure(MESSAGES.bundle);
    const bytes = await fs.readFile(file);
    if (bytes.length !== stat.size) throw failure(MESSAGES.bundle);
    return bytes;
  }
  /** Verify the bundled artifact against plugin/build/manifest.json before anything else is inspected. */
  async function bundle() {
    const root = read(options.productRoot);
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw failure(MESSAGES.bundle);
    const build = path.join(root, 'plugin', 'build');
    try {
      await noLinks(build);
      const manifest = JSON.parse((await boundedFile(path.join(build, 'manifest.json'), MAX_MANIFEST_BYTES)).toString('utf8'));
      if (!manifest || manifest.schemaVersion !== 1 || manifest.preferredArtifact !== ARTIFACT || !Array.isArray(manifest.artifacts)) throw failure(MESSAGES.bundle);
      const entry = manifest.artifacts.find(item => item && item.name === ARTIFACT);
      if (!entry || !SHA256.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.bytes)) throw failure(MESSAGES.bundle);
      const bytes = await boundedFile(path.join(build, ARTIFACT), MAX_ARTIFACT_BYTES);
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw failure(MESSAGES.bundle);
      if (!ownedPluginText(bytes.toString('utf8'), ARTIFACT) || containsCredential(bytes)) throw failure(MESSAGES.bundle);
      return { bytes, sha256: entry.sha256, pluginVersion: typeof manifest.pluginVersion === 'string' && VERSION.test(manifest.pluginVersion) ? manifest.pluginVersion : null };
    } catch (error) { if (error.safe) throw error; throw failure(MESSAGES.bundle); }
  }
  function pluginsRoot() {
    const explicit = read(options.pluginsDirectory);
    if (explicit !== undefined && explicit !== null) {
      if (typeof explicit !== 'string' || !path.isAbsolute(explicit)) throw failure(MESSAGES.folder);
      return path.resolve(explicit);
    }
    if (platform !== 'win32') throw failure(MESSAGES.platform);
    const local = read(options.localAppData) ?? process.env.LOCALAPPDATA;
    if (typeof local !== 'string' || !path.isAbsolute(local)) throw failure(MESSAGES.folder);
    return path.resolve(path.join(local, 'Roblox', 'Plugins'));
  }
  async function existingPlugin(target, filename) {
    await noLinks(target);
    let stat;
    try { stat = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ARTIFACT_BYTES) throw failure(MESSAGES.foreign);
    const bytes = await fs.readFile(target);
    if (!ownedPluginText(bytes.toString('utf8'), filename)) throw failure(MESSAGES.foreign);
    return bytes;
  }
  /** Compare what is installed with the verified bundle. Never writes. */
  async function inspect() {
    const verified = await bundle();
    const root = pluginsRoot();
    await noLinks(root);
    const target = path.join(root, ARTIFACT);
    const original = await existingPlugin(target, ARTIFACT), legacy = [];
    for (const name of LEGACY) {
      const from = path.join(root, name), bytes = await existingPlugin(from, name);
      if (bytes) legacy.push({ name, from, bytes });
    }
    const state = original && hash(original) === verified.sha256 && legacy.length === 0 ? 'installed' : original || legacy.length ? 'outdated' : 'missing';
    return { verified, root, target, original, legacy, state };
  }
  const reply = (state, pluginVersion, message, changed) => Object.freeze({ version: 1, state, pluginVersion: pluginVersion ?? null, message, ...(changed === undefined ? {} : { changed }) });
  const safeMessage = error => error && error.safe ? error.message : MESSAGES.unavailable;

  async function status() {
    if (!enabled) return reply('unavailable', null, MESSAGES.disabled);
    try {
      const found = await inspect();
      return reply(found.state, found.verified.pluginVersion, MESSAGES[found.state]);
    } catch (error) {
      return reply('unavailable', null, safeMessage(error));
    }
  }

  async function install() {
    if (!enabled) throw failure(MESSAGES.disabled);
    if (busy) throw failure(MESSAGES.busy);
    busy = true;
    try {
      const found = await inspect();
      const { verified, root, target, original, legacy } = found;
      if (found.state === 'installed') return reply('installed', verified.pluginVersion, MESSAGES.current, false);
      const update = found.state === 'outdated';
      const accepted = await options.confirm({
        title: update ? 'Update Arcane Studio plugin' : 'Install Arcane Studio plugin',
        message: update ? 'Update the Arcane plugin in Roblox Studio?' : 'Install the Arcane plugin into Roblox Studio?',
        detail: 'Arcane will copy its verified plugin' + (verified.pluginVersion ? ' (version ' + verified.pluginVersion + ')' : '') +
          ' into your Roblox Studio Plugins folder. The plugin file holds no keys. After Studio restarts, click Connect in the Arcane plugin.',
        confirmLabel: update ? 'Update plugin' : 'Install plugin',
      });
      if (accepted !== true) return reply(found.state, verified.pluginVersion, MESSAGES.cancelled, false);
      await fs.mkdir(root, { recursive: true });
      await noLinks(root);
      const real = await fs.realpath(root);
      const samePath = (a, b) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      if (!samePath(path.resolve(real), root)) throw failure(MESSAGES.folder);
      const backups = read(options.backupDirectory);
      const backupPath = name => {
        if (typeof backups !== 'string' || !path.isAbsolute(backups)) throw failure(MESSAGES.unavailable);
        return path.join(backups, randomUUID() + '.' + name);
      };
      if (original || legacy.length) { await noLinks(backups); await fs.mkdir(backups, { recursive: true }); }
      if (original) await fs.writeFile(backupPath(ARTIFACT), original, { flag: 'wx' });
      const temp = path.join(root, 'ArcaneLocalBridge.' + randomUUID() + '.partial');
      await fs.writeFile(temp, verified.bytes, { flag: 'wx' });
      try {
        const written = await fs.readFile(temp);
        if (hash(written) !== verified.sha256 || containsCredential(written)) throw failure(MESSAGES.bundle);
        const current = await existingPlugin(target, ARTIFACT);
        if (Boolean(current) !== Boolean(original) || (current && !current.equals(original))) throw failure(MESSAGES.changed);
        await noLinks(target);
        await fs.rename(temp, target);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      if (hash(await fs.readFile(target)) !== verified.sha256) throw failure(MESSAGES.unavailable);
      for (const old of legacy) {
        // Revalidate before moving so a concurrent replacement is never touched.
        const current = await existingPlugin(old.from, old.name);
        if (!current || !current.equals(old.bytes)) throw failure(MESSAGES.changed);
        await fs.rename(old.from, backupPath(old.name));
      }
      return reply('installed', verified.pluginVersion, MESSAGES.updated, true);
    } finally { busy = false; }
  }

  /** IPC: two zero-argument intents. `trusted(event)` owns the sender/frame/origin checks. */
  function installIpc(ipcMain, { trusted }) {
    for (const [action, run] of [['status', status], ['install', install]]) {
      ipcMain.handle('arcane:studio-plugin-' + action, async (event, ...args) => {
        try {
          if (args.length || !trusted(event)) throw failure(MESSAGES.unavailable);
          return await run();
        } catch (error) { throw new Error(safeMessage(error)); }
      });
    }
  }
  return Object.freeze({ status, install, installIpc });
}

module.exports = { createStudioPluginInstaller, containsCredential, ARTIFACT, STATES, MESSAGES };
