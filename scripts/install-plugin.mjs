import { mkdir, readFile, writeFile, lstat, realpath, rename } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from './build-plugin.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function inside(root, target) {
  const part = relative(root, target);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
}
async function noLinks(target) {
  for (let current = resolve(target);;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Link/junction not permitted in install path.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
async function existingPlugin(target, filename) {
  await noLinks(target);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('Expected a bounded single-link plugin file.');
    const bytes = await readFile(target), text = bytes.toString('utf8');
    const owned = filename.endsWith('.lua')
      ? text.startsWith('--!strict') && text.includes('local __arcaneFactories')
      : text.startsWith('<?xml ') && text.includes('<string name="Name">ArcaneLocalBridge</string>');
    if (!owned) throw new Error('A different plugin occupies this name; refusing to overwrite or move it.');
    return bytes;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Verify the complete build before inspecting or changing the selected plugin folder. */
export async function installPlugin({ localAppData = process.env.LOCALAPPDATA, installDirectory, repository = repo } = {}) {
  if (process.platform !== 'win32' && !installDirectory) throw new Error('This installer currently supports Windows. Use the documented manual install on other systems.');
  if (!localAppData && !installDirectory) throw new Error('LOCALAPPDATA is unavailable.');
  repository = resolve(repository);
  const build = join(repository, 'plugin', 'build');
  await noLinks(build);
  const { manifest } = await buildPlugin({ sourceDir: join(repository, 'plugin', 'src'), outDir: build, check: true });
  const filename = manifest.preferredArtifact;
  if (filename !== 'ArcaneLocalBridge.rbxmx') throw new Error('Expected the reviewed modular plugin.');
  const bytes = await readFile(join(build, filename)), artifact = manifest.artifacts.find(item => item.name === filename);
  if (!artifact || hash(bytes) !== artifact.sha256 || bytes.length !== artifact.bytes) throw new Error('Plugin artifact checksum failed.');
  const root = resolve(installDirectory ?? join(localAppData, 'Roblox', 'Plugins'));
  await noLinks(root);
  const target = join(root, filename);
  // Preflight every old filename first: an unrelated file must leave all of them intact.
  const original = await existingPlugin(target, filename), legacy = [];
  for (const name of ['ArcaneLocalBridge.lua', 'ArcaneLocalBridge.rbxm']) {
    const from = join(root, name), old = await existingPlugin(from, name);
    if (old) legacy.push({ name, from, bytes: old });
  }
  if (original && hash(original) === artifact.sha256 && legacy.length === 0) {
    return { installed: true, changed: false, target, sha256: artifact.sha256, backup: null, migrated: [], studioReloadRequired: true };
  }
  await mkdir(root, { recursive: true });
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!samePath(await realpath(root), root)) throw new Error('Install directory resolves to a different location.');
  const backupRoot = join(repository, 'runtime', 'plugin-backups');
  await noLinks(backupRoot); await mkdir(backupRoot, { recursive: true });
  const backupPath = name => {
    const result = join(backupRoot, randomUUID() + '.' + name);
    if (!inside(repository, result)) throw new Error('Backup escapes repository.');
    return result;
  };
  let backup = null;
  if (original) { backup = backupPath(filename); await writeFile(backup, original, { flag: 'wx' }); }
  const temp = join(root, 'ArcaneLocalBridge.' + randomUUID() + '.partial');
  await writeFile(temp, bytes, { flag: 'wx' });
  const current = await existingPlugin(target, filename);
  if (Boolean(current) !== Boolean(original) || (current && !current.equals(original))) throw new Error('Plugin changed during installation. Backup retained.');
  await noLinks(target); await rename(temp, target);
  if (hash(await readFile(target)) !== artifact.sha256) throw new Error('Installed plugin checksum mismatch. Backup retained.');
  const migrated = [];
  for (const old of legacy) {
    // Revalidate before removal so a concurrent replacement is never moved.
    const current = await existingPlugin(old.from, old.name);
    if (!current || !current.equals(old.bytes)) throw new Error('Legacy plugin changed during installation. Backups retained; inspect the plugin folder before reloading Studio.');
    const destination = backupPath(old.name);
    await rename(old.from, destination);
    migrated.push({ from: old.from, backup: destination, sha256: hash(old.bytes) });
  }
  return { installed: true, changed: true, target, sha256: artifact.sha256, backup, migrated, studioReloadRequired: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('No arbitrary install flags are accepted.');
  console.log(JSON.stringify(await installPlugin(), null, 2));
}
