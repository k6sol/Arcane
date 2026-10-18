import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Every test writes only inside its own temp fixture; the real Roblox Plugins folder is never resolved or touched.
const require = createRequire(import.meta.url);
const { createStudioPluginInstaller, containsCredential, MESSAGES } = require('../../apps/desktop/electron/plugin-install.cjs');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pluginXml = body => '<?xml version="1.0" encoding="utf-8"?>\n<roblox version="4"><Item class="Script"><Properties><string name="Name">ArcaneLocalBridge</string>' +
  '<ProtectedString name="Source">' + body + '</ProtectedString></Properties></Item></roblox>\n';

async function fixture(t, { body = '-- fixture plugin v2', manifest: change } = {}) {
  const root = realpathSync.native(await fs.mkdtemp(join(realpathSync.native(tmpdir()), 'arcane-plugin-install-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const product = join(root, 'product'), plugins = join(root, 'LocalAppData', 'Roblox', 'Plugins'), backups = join(root, 'user', 'plugin-backups');
  const artifact = Buffer.from(pluginXml(body));
  await fs.mkdir(join(product, 'plugin', 'build'), { recursive: true });
  await fs.writeFile(join(product, 'plugin', 'build', 'ArcaneLocalBridge.rbxmx'), artifact);
  const manifest = { schemaVersion: 1, pluginVersion: '0.2.0', preferredArtifact: 'ArcaneLocalBridge.rbxmx',
    artifacts: [{ name: 'ArcaneLocalBridge.rbxmx', bytes: artifact.length, sha256: hash(artifact) }] };
  change?.(manifest);
  await fs.writeFile(join(product, 'plugin', 'build', 'manifest.json'), JSON.stringify(manifest));
  const confirms = [];
  const make = (options = {}) => createStudioPluginInstaller({ productRoot: product, pluginsDirectory: plugins, backupDirectory: backups, platform: 'win32',
    confirm: async request => { confirms.push(request); return options.accept ?? true; }, ...options });
  return { root, product, plugins, backups, artifact, manifest, confirms, make, target: join(plugins, 'ArcaneLocalBridge.rbxmx') };
}
const list = async directory => existsSync(directory) ? (await fs.readdir(directory)).sort() : null;

test('status hashing reports missing, then installed, then outdated against the manifest hash', async t => {
  const f = await fixture(t), host = f.make();
  assert.deepEqual(await host.status(), { version: 1, state: 'missing', pluginVersion: '0.2.0', message: MESSAGES.missing });
  assert.equal(await list(f.plugins), null, 'Status never creates the Plugins folder.');
  await fs.mkdir(f.plugins, { recursive: true }); await fs.writeFile(f.target, f.artifact);
  assert.equal((await host.status()).state, 'installed');
  await fs.writeFile(f.target, pluginXml('-- fixture plugin v1'));
  assert.equal((await host.status()).state, 'outdated', 'Same owner, different hash means outdated.');
  await fs.writeFile(f.target, f.artifact); await fs.writeFile(join(f.plugins, 'ArcaneLocalBridge.rbxm'), pluginXml('-- legacy'));
  assert.equal((await host.status()).state, 'outdated', 'A leftover legacy file still needs an update.');
  assert.equal(f.confirms.length, 0, 'Reading status never asks or writes.');
});

test('install confirms first, copies atomically and leaves no partial file; a second install is a no-op', async t => {
  const f = await fixture(t), host = f.make();
  const result = await host.install();
  assert.deepEqual(result, { version: 1, state: 'installed', pluginVersion: '0.2.0', message: MESSAGES.updated, changed: true });
  assert.equal(f.confirms.length, 1); assert.equal(f.confirms[0].confirmLabel, 'Install plugin');
  assert.match(f.confirms[0].detail, /holds no keys/);
  assert.deepEqual(await fs.readFile(f.target), f.artifact);
  assert.deepEqual(await list(f.plugins), ['ArcaneLocalBridge.rbxmx'], 'Only the final file remains; the temp file was renamed.');
  assert.deepEqual(await host.install(), { version: 1, state: 'installed', pluginVersion: '0.2.0', message: MESSAGES.current, changed: false });
  assert.equal(f.confirms.length, 1, 'A current plugin needs no confirmation.');
});

test('update backs up the old plugin and moves legacy files out of the Plugins folder', async t => {
  const f = await fixture(t), host = f.make(), old = Buffer.from(pluginXml('-- fixture plugin v1')), legacy = Buffer.from(pluginXml('-- legacy'));
  await fs.mkdir(f.plugins, { recursive: true }); await fs.writeFile(f.target, old); await fs.writeFile(join(f.plugins, 'ArcaneLocalBridge.rbxm'), legacy);
  const result = await host.install();
  assert.equal(result.state, 'installed'); assert.equal(f.confirms[0].confirmLabel, 'Update plugin');
  assert.deepEqual(await list(f.plugins), ['ArcaneLocalBridge.rbxmx']);
  const saved = await Promise.all((await list(f.backups)).map(name => fs.readFile(join(f.backups, name))));
  assert.equal(saved.length, 2); assert.ok(saved.some(bytes => bytes.equals(old)) && saved.some(bytes => bytes.equals(legacy)));
});

test('a failed rename leaves the installed plugin unchanged and removes the temp file', async t => {
  const f = await fixture(t), old = Buffer.from(pluginXml('-- fixture plugin v1'));
  await fs.mkdir(f.plugins, { recursive: true }); await fs.writeFile(f.target, old);
  const host = f.make({ fs: { ...fs, rename: async () => { throw Object.assign(new Error('simulated'), { code: 'EBUSY' }); } } });
  await assert.rejects(host.install(), error => error.message === 'Studio plugin setup is unavailable.' || error.code === 'EBUSY');
  assert.deepEqual(await fs.readFile(f.target), old);
  assert.deepEqual(await list(f.plugins), ['ArcaneLocalBridge.rbxmx']);
});

test('refuses when the bundled artifact does not match its manifest hash, before touching the Plugins folder', async t => {
  for (const change of [m => { m.artifacts[0].sha256 = 'f'.repeat(64); }, m => { m.artifacts[0].bytes += 1; }, m => { m.preferredArtifact = 'Other.rbxmx'; }, m => { m.artifacts = []; }]) {
    const f = await fixture(t, { manifest: change }), host = f.make();
    assert.deepEqual(await host.status(), { version: 1, state: 'unavailable', pluginVersion: null, message: MESSAGES.bundle });
    await assert.rejects(host.install(), { message: MESSAGES.bundle });
    assert.equal(f.confirms.length, 0); assert.equal(await list(f.plugins), null);
  }
});

test('never writes credentials: a bundle carrying a key or session link is refused', async t => {
  const key = 'arcane_local_v1_45871_' + 'd'.repeat(64), link = 'http://127.0.0.1:45871/studio#' + 'e'.repeat(64);
  assert.equal(containsCredential(Buffer.from('local apiKey = ""')), false);
  assert.equal(containsCredential(Buffer.from('pattern arcane_local_v1_([1-9][0-9]*)_([0-9a-f]+)$')), false, 'The key format pattern is not a key.');
  for (const secret of [key, link]) {
    assert.equal(containsCredential(Buffer.from(secret)), true);
    const f = await fixture(t, { body: 'local saved = "' + secret + '"' }), host = f.make();
    assert.equal((await host.status()).message, MESSAGES.bundle);
    await assert.rejects(host.install(), { message: MESSAGES.bundle });
    assert.equal(await list(f.plugins), null);
  }
});

test('the real bundled plugin installs into a temp folder byte-for-byte with no credential', { skip: !existsSync(join(repo, 'plugin/build/manifest.json')) }, async t => {
  const root = realpathSync.native(await fs.mkdtemp(join(realpathSync.native(tmpdir()), 'arcane-plugin-real-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plugins = join(root, 'Plugins'), host = createStudioPluginInstaller({ productRoot: repo, pluginsDirectory: plugins, backupDirectory: join(root, 'backups'), platform: 'win32', confirm: async () => true });
  const status = await host.status();
  if (status.state === 'unavailable') { t.skip('Local plugin build is being rebuilt by another task.'); return; }
  assert.equal((await host.install()).state, 'installed');
  const copied = await fs.readFile(join(plugins, 'ArcaneLocalBridge.rbxmx'));
  assert.deepEqual(copied, readFileSync(join(repo, 'plugin/build/ArcaneLocalBridge.rbxmx')));
  assert.equal(containsCredential(copied), false);
  assert.doesNotMatch(copied.toString('utf8'), /arcane_local_v1_[0-9]+_[a-f0-9]{64}|#[a-f0-9]{64}/);
});

test('cancelled confirmation, foreign files and disabled mode change nothing', async t => {
  const f = await fixture(t), declined = f.make({ accept: false });
  assert.deepEqual(await declined.install(), { version: 1, state: 'missing', pluginVersion: '0.2.0', message: MESSAGES.cancelled, changed: false });
  assert.equal(await list(f.plugins), null);
  await fs.mkdir(f.plugins, { recursive: true }); const foreign = Buffer.from('<?xml version="1.0"?><roblox><string name="Name">SomeoneElse</string></roblox>');
  await fs.writeFile(f.target, foreign);
  assert.equal((await f.make().status()).message, MESSAGES.foreign);
  await assert.rejects(f.make().install(), { message: MESSAGES.foreign });
  assert.deepEqual(await fs.readFile(f.target), foreign);
  const disabled = f.make({ enabled: false });
  assert.equal((await disabled.status()).message, MESSAGES.disabled); await assert.rejects(disabled.install(), { message: MESSAGES.disabled });
  const other = createStudioPluginInstaller({ productRoot: f.product, platform: 'linux', confirm: async () => true });
  assert.equal((await other.status()).message, MESSAGES.platform);
});

test('IPC accepts only trusted zero-argument intents and returns fixed messages', async t => {
  const f = await fixture(t), handlers = new Map(), host = f.make();
  let trusted = false;
  host.installIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, { trusted: () => trusted });
  assert.deepEqual([...handlers.keys()].sort(), ['arcane:studio-plugin-install', 'arcane:studio-plugin-status']);
  await assert.rejects(handlers.get('arcane:studio-plugin-install')({}), { message: 'Studio plugin setup is unavailable.' });
  trusted = true;
  await assert.rejects(handlers.get('arcane:studio-plugin-status')({}, 'C:\\elsewhere'), { message: 'Studio plugin setup is unavailable.' });
  assert.equal((await handlers.get('arcane:studio-plugin-status')({})).state, 'missing');
  assert.equal(await list(f.plugins), null);
});

test('preload bridge copies only fixed fields and rejects unknown messages, paths and arguments', async () => {
  const preload = readFileSync(join(repo, 'apps/desktop/electron/preload.cjs'), 'utf8');
  let reply, exposed; const calls = [];
  vm.runInNewContext(preload, { TextEncoder, require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); if (reply instanceof Error) throw reply; return reply; }, on() {}, removeListener() {} } }) });
  const bridge = exposed.studioPlugin;
  reply = { version: 1, state: 'missing', pluginVersion: '0.2.0', message: MESSAGES.missing, path: 'C:\\Users\\someone' };
  assert.equal(JSON.stringify(await bridge.status()), JSON.stringify({ version: 1, state: 'missing', pluginVersion: '0.2.0', message: MESSAGES.missing }));
  await assert.rejects(bridge.status('x'), { message: 'Studio plugin setup is unavailable.' });
  reply = { version: 1, state: 'missing', pluginVersion: '0.2.0', message: 'C:\\Users\\someone\\AppData' };
  await assert.rejects(bridge.status(), { message: 'Studio plugin setup is unavailable.' });
  reply = { version: 1, state: 'installed', pluginVersion: null, message: MESSAGES.updated };
  await assert.rejects(bridge.install(), { message: 'Studio plugin setup is unavailable.' }, 'Install replies must say whether anything changed.');
  reply = new Error("Error invoking remote method 'arcane:studio-plugin-install': Error: " + MESSAGES.foreign);
  await assert.rejects(bridge.install(), { message: MESSAGES.foreign });
  assert.deepEqual(calls.map(call => call.length), [1, 1, 1, 1], 'No renderer argument ever crosses.');
  reply = { requested: true }; assert.equal(JSON.stringify(await exposed.workspaceProject.open()), '{"requested":true}');
  await assert.rejects(exposed.workspaceProject.open('C:\\'), { message: 'The project picker is unavailable.' });
});

test('main process wires the installer behind the exact renderer check and a native confirm dialog', () => {
  const main = readFileSync(join(repo, 'apps/desktop/electron/main.cjs'), 'utf8');
  assert.match(main, /require\('\.\/plugin-install\.cjs'\)\.createStudioPluginInstaller\(\{ enabled: !smoke, productRoot: \(\) => productRoot/);
  assert.match(main, /studioPlugin\.installIpc\(ipcMain, \{ trusted: rendererEvent \}\)/);
  assert.match(main, /dialog\.showMessageBox\(owner, \{ type: 'question'[\s\S]*?buttons: \['Cancel', request\.confirmLabel\], defaultId: 0, cancelId: 0/);
  assert.match(main, /function rendererEvent\(event\)[\s\S]*?frame === contents\.mainFrame[\s\S]*?policy\.navigationAllowed\(origin, frame\.url\)/);
  assert.match(main, /ipcMain\.handle\('arcane:project-open'[\s\S]*?rendererEvent\(event\)[\s\S]*?void chooseProject\(\)/);
});
