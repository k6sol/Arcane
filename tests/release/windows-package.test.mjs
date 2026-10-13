// Offline packaging fixtures only: never download or execute Electron, the daemon,
// Studio, providers or Blender. Executable bytes and the Node probe are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { packageWindows, verifyWindowsBundle, hasPrivateKeyMaterial } from '../../scripts/package-windows.mjs';
import { REQUIRED_FRONTEND_FILES, BRAND_BITMAP_PATH } from '../../scripts/create-local-release.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWooAAAAASUVORK5CYII=', 'base64');
function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(machine, 132);
  bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x20b, 152);
  return bytes;
}
// Synthetic notice markers exercise the completeness gate. This is fixture
// data, never a replacement for the real official Node distribution LICENSE.
const fixtureLicense = 'Node.js is licensed for use as follows:\n' +
  'Permission is hereby granted, free of charge\nexternally maintained libraries\nAcorn OpenSSL libuv V8\n' +
  'Synthetic offline fixture notice.\n'.repeat(2000);

async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'arcane-windows-test-'));
  t.after(async () => {
    // Cleanup is confined to this freshly-owned test scratch tree; the packager
    // never removes or overwrites real release directories.
    const target = resolve(scratch), boundary = resolve(tmpdir()), path = relative(boundary, target);
    assert.ok(path.startsWith('arcane-windows-test-') && !path.includes(sep) && !isAbsolute(path));
    assert.equal((await lstat(target)).isSymbolicLink(), false);
    await rm(target, { recursive: true, force: true });
  });
  const root = join(scratch, 'checkout [spaces] & Unicode Ω');
  await mkdir(root);
  const write = async (path, value) => {
    const target = join(root, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, value);
  };
  const writeJson = (path, value) => write(path, JSON.stringify(value));
  for (const directory of ['apps', 'packages', 'workers', 'plugin', 'scripts', 'skills', 'docs', 'tests', 'dist', '.github']) await mkdir(join(root, directory));
  const pkg = { name: 'arcane', version: '0.1.0', private: true, type: 'module', engines: { node: '>=24' },
    dependencies: { '@modelcontextprotocol/sdk': '1.32.1', zod: '4.6.6' }, devDependencies: { electron: '44.7.0', typescript: '7.0.2' } };
  const locked = {
    '': { ...pkg },
    'node_modules/electron': { version: '44.7.0', dev: true },
    'node_modules/typescript': { version: '7.0.2', dev: true },
    'node_modules/@modelcontextprotocol/sdk': { version: '1.32.1', dependencies: { 'helper-a': '^1' },
      peerDependencies: { zod: '^4', 'optional-peer': '^1' }, peerDependenciesMeta: { 'optional-peer': { optional: true } } },
    'node_modules/@modelcontextprotocol/sdk/node_modules/helper-a': { version: '1.0.0' },
    'node_modules/zod': { version: '4.6.6', dependencies: { 'helper-a': '^2' }, optionalDependencies: { 'optional-helper': '^1' } },
    'node_modules/helper-a': { version: '2.0.0' },
    'node_modules/optional-helper': { version: '1.0.0', optional: true, os: ['linux'] },
    'node_modules/optional-peer': { version: '1.0.0' },
    'node_modules/unrelated': { version: '1.0.0' },
  };
  await writeJson('package.json', pkg);
  await writeJson('package-lock.json', { name: 'arcane', version: '0.1.0', lockfileVersion: 3, packages: locked });
  await writeJson('tsconfig.json', {});
  for (const path of ['LICENSE', 'README.md']) await write(path, 'Fixture content.\n');
  for (const path of ['dist/apps/daemon/src/product-main.js', 'dist/apps/mcp/src/main.js', 'plugin/build/ArcaneLocalBridge.lua']) await write(path, '// Fixture only.\n');
  await writeJson('plugin/build/manifest.json', {});
  const ts = 'export const fixture = true;\n';
  for (const path of REQUIRED_FRONTEND_FILES) {
    const content = path === BRAND_BITMAP_PATH ? png : path.endsWith('.map')
      ? JSON.stringify({ version: 3, sources: ['../../../../apps/desktop/src/' + path.split('/').at(-1).replace('.js.map', '.ts')], sourcesContent: [ts] })
      : path.endsWith('.ts') ? ts : '// Fixture only.\n';
    await write(path, content);
  }
  for (const [path, record] of Object.entries(locked).filter(([path]) => path.startsWith('node_modules/'))) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 13);
    await writeJson(path + '/package.json', { name, ...record });
    await write(path + '/index.js', '// ' + name + ' fixture.\n');
    await write(path + '/LICENSE', 'Fixture dependency license.\n');
  }
  const electronDist = join(root, 'toolchains/electron/dist');
  await writeJson('toolchains/electron/package.json', { name: 'electron', version: '44.7.0' });
  for (const file of ['LICENSE', 'LICENSES.chromium.html', 'resources.pak', 'chrome_100_percent.pak',
    'chrome_200_percent.pak', 'icudtl.dat', 'ffmpeg.dll', 'v8_context_snapshot.bin', 'locales/en-US.pak']) {
    await write('toolchains/electron/dist/' + file, 'Electron fixture ' + file + '\n');
  }
  await write('toolchains/electron/dist/electron.exe', pe());
  await write('toolchains/electron/dist/version', '44.7.0');
  await write('toolchains/electron/dist/resources/default_app.asar', 'Never package the default application.');
  for (const file of ['main.cjs', 'policy.cjs', 'preload.cjs', 'code-verification.cjs', 'provider-setup.cjs', 'provider-login.cjs', 'studio-key-vault.cjs', 'workspace-preferences.cjs']) await write('apps/desktop/electron/' + file, '// Secure host fixture: ' + file + '\n');
  await write('apps/desktop/electron/icon.png', png);
  await write('apps/desktop/electron/node-LICENSE.txt', fixtureLicense);
  const nodeExecutable = join(root, 'toolchains/node/node.exe');
  await write('toolchains/node/node.exe', pe());
  const probes = [];
  const inspectNode = async executable => { probes.push(executable); return { version: 'v24.21.0', platform: 'win32', arch: 'x64' }; };
  const options = { repository: root, electronDist, nodeExecutable, inspectNode };
  return { root, scratch, write, writeJson, pkg, locked, options, probes };
}
async function manifest(directory) { return JSON.parse(await readFile(join(directory, 'windows-manifest.json'), 'utf8')); }
async function mutateManifest(directory, change) {
  const value = await manifest(directory); change(value);
  await writeFile(join(directory, 'windows-manifest.json'), JSON.stringify(value));
}

test('directory package has a real PE exe, explicit app entry, standalone Node and only production closure', async t => {
  const { root, write, options, probes } = await fixture(t);
  await write('runtime/product/daemon.json', '{"token":"never-copy-runtime"}');
  await write('.codex/auth.json', '{"access_token":"never-copy-provider-auth"}');
  await write('apps/mcp/generated/claude.mcp.json', '{"password":"never-copy-generated"}');
  await write('node_modules/zod/tests/auth.json', '{"access_token":"never-copy-test-data"}');
  const result = await packageWindows(options), data = await manifest(result.directory);
  assert.equal(probes.length, 1); assert.equal(probes[0], options.nodeExecutable);
  assert.equal(result.signed, false); assert.equal(result.installer, false);
  assert.equal(result.installedNodeRequired, false); assert.equal(result.applicationLaunchVerified, false);
  assert.equal(result.integrityOnly, true);
  assert.ok(result.directory.startsWith(join(root, 'runtime/windows/arcane-win32-x64-')));
  assert.equal(result.executable, join(result.directory, 'Arcane.exe'));
  assert.equal((await readFile(result.executable)).subarray(0, 2).toString(), 'MZ');
  assert.equal((await lstat(result.executable)).nlink, 1);
  assert.equal((await lstat(join(result.directory, 'resources/node/node.exe'))).nlink, 1);
  assert.equal(await readFile(join(result.directory, 'resources/node/LICENSE'), 'utf8'), fixtureLicense);
  assert.deepEqual(JSON.parse(await readFile(join(result.directory, 'resources/app/package.json'), 'utf8')), {
    name: 'arcane-desktop', productName: 'Arcane', version: '0.1.0', private: true, main: 'main.cjs', type: 'commonjs',
  });
  assert.ok(data.files.some(file => file.path === 'resources/app/icon.png'));
  assert.ok(data.files.some(file => file.path === 'resources/app/code-verification.cjs'));
  assert.ok(data.files.some(file => file.path === 'resources/app/studio-key-vault.cjs'));
  assert.ok(data.files.some(file => file.path === 'resources/app/workspace-preferences.cjs'));
  assert.ok(data.files.some(file => file.path === 'resources/app/provider-login.cjs'));
  assert.ok(data.files.some(file => file.path === 'resources/product/dist/apps/desktop/src/studio-key-settings.js'));
  assert.deepEqual(data.dependencies.map(dep => dep.path), [
    'node_modules/@modelcontextprotocol/sdk', 'node_modules/@modelcontextprotocol/sdk/node_modules/helper-a',
    'node_modules/helper-a', 'node_modules/zod',
  ]);
  assert.ok(data.files.every(file => !/(?:default_app\.asar|app\.asar|(?:^|\/)runtime\/|auth\.json|generated\/|typescript\/|node_modules\/electron\/|unrelated\/|optional-peer\/|optional-helper\/)/.test(file.path)));
  assert.equal(JSON.stringify(data).includes(root), false); assert.equal(JSON.stringify(data).includes('never-copy-'), false);
  const proof = await verifyWindowsBundle(result.directory);
  assert.equal(proof.files, data.fileCount); assert.equal(proof.bytes, data.totalBytes);
  assert.equal(proof.manifestSha256, hash(await readFile(join(result.directory, 'windows-manifest.json'))));
});

test('each invocation retains a unique owned directory and unchanged prior output', async t => {
  const { options } = await fixture(t);
  const first = await packageWindows(options), before = await readFile(join(first.directory, 'windows-manifest.json'));
  const second = await packageWindows(options);
  assert.notEqual(first.directory, second.directory);
  assert.deepEqual(await readFile(join(first.directory, 'windows-manifest.json')), before);
  await verifyWindowsBundle(first.directory); await verifyWindowsBundle(second.directory);
});

test('tampered executables, product assets and dependency bytes fail integrity', async t => {
  const { options } = await fixture(t);
  for (const path of ['Arcane.exe', 'resources/node/node.exe', 'resources/product/apps/desktop/public/studio.html',
    'resources/product/node_modules/zod/index.js']) {
    const result = await packageWindows(options);
    await writeFile(join(result.directory, path), 'Tampered fixture.');
    await assert.rejects(verifyWindowsBundle(result.directory), /checksum/);
  }
});

test('unlisted payloads and mutable directories are rejected, including excluded release roots', async t => {
  const { options } = await fixture(t);
  const first = await packageWindows(options);
  await writeFile(join(first.directory, 'unlisted.txt'), 'Unlisted.');
  await assert.rejects(verifyWindowsBundle(first.directory), /Unlisted/);
  const second = await packageWindows(options);
  await mkdir(join(second.directory, 'resources/product/runtime'));
  await assert.rejects(verifyWindowsBundle(second.directory), /Forbidden/);
  const third = await packageWindows(options);
  await mkdir(join(third.directory, 'resources/app/personal'));
  await writeFile(join(third.directory, 'resources/app/personal/auth.json'), '{}');
  await assert.rejects(verifyWindowsBundle(third.directory), /Forbidden/);
});

test('manifest traversal, duplicate case paths, false provenance and missing transitive inventories fail', async t => {
  const { options } = await fixture(t);
  for (const [change, pattern] of [
    [data => { data.files[0].path = '../outside'; }, /Forbidden/],
    [data => { data.files[1].path = data.files[0].path.toUpperCase(); }, /descriptor/],
    [data => { data.sourceRelease.manifestSha256 = '0'.repeat(64); }, /snapshot manifest/],
    [data => { data.dependencies.pop(); }, /dependency inventory/],
    [data => { data.runtime.installedNodeRequired = true; }, /manifest/],
  ]) {
    const result = await packageWindows(options); await mutateManifest(result.directory, change);
    await assert.rejects(verifyWindowsBundle(result.directory), pattern);
  }
});

test('Node architecture, version, standalone identity and full license are required before output', async t => {
  const { root, write, options } = await fixture(t);
  for (const info of [
    { version: 'v23.9.0', platform: 'win32', arch: 'x64' },
    { version: 'v24.21.0', platform: 'linux', arch: 'x64' },
    { version: 'v24.21.0', platform: 'win32', arch: 'arm64' },
    { version: 'v24.21.0-rc.1', platform: 'win32', arch: 'x64' },
    { version: 'v24.21.0', platform: 'win32', arch: 'x64', electron: '44.7.0' },
  ]) await assert.rejects(packageWindows({ ...options, inspectNode: async () => info }), /standalone stable Node/);
  await write('toolchains/node/node.exe', pe(0x14c));
  await assert.rejects(packageWindows(options), /Node is not a Windows x64/);
  await write('toolchains/node/node.exe', pe());
  await write('apps/desktop/electron/node-LICENSE.txt', 'A short MIT extract is insufficient.');
  await assert.rejects(packageWindows(options), /complete official Node LICENSE/);
  await rm(join(root, 'apps/desktop/electron/node-LICENSE.txt'));
  await assert.rejects(packageWindows(options), /Missing complete Node LICENSE/);
  await assert.rejects(packageWindows({ ...options, nodeLicense: 'relative.txt' }), /absolute file/);
  assert.equal((await readdir(root)).includes('runtime'), false);
});

test('a complete supplied license or installed Node directory license is copied verbatim', async t => {
  const { write, options } = await fixture(t);
  await write('toolchains/node/LICENSE', fixtureLicense + 'Installed fixture.\n');
  const first = await packageWindows(options);
  assert.equal(await readFile(join(first.directory, 'resources/node/LICENSE'), 'utf8'), fixtureLicense + 'Installed fixture.\n');
  await write('toolchains/supplied-LICENSE.txt', fixtureLicense + 'Explicit fixture.\n');
  const second = await packageWindows({ ...options, nodeLicense: join(options.repository, 'toolchains/supplied-LICENSE.txt') });
  assert.equal(await readFile(join(second.directory, 'resources/node/LICENSE'), 'utf8'), fixtureLicense + 'Explicit fixture.\n');
});

test('Electron must match exact installed and lockfile pins and Windows x64', async t => {
  const { write, writeJson, options } = await fixture(t);
  await write('toolchains/electron/dist/version', '44.7.1');
  await assert.rejects(packageWindows(options), /exact pinned Electron/);
  await write('toolchains/electron/dist/version', '44.7.0');
  await writeJson('toolchains/electron/package.json', { name: 'electron', version: '44.7.1' });
  await assert.rejects(packageWindows(options), /exact pinned Electron/);
  await writeJson('toolchains/electron/package.json', { name: 'electron', version: '44.7.0' });
  await write('toolchains/electron/dist/electron.exe', pe(0xaa64));
  await assert.rejects(packageWindows(options), /Electron is not a Windows x64/);
});

test('missing host, missing transitive package and stale installed package fail instead of falling back', async t => {
  const { root, writeJson, options, locked } = await fixture(t);
  await rm(join(root, 'apps/desktop/electron/code-verification.cjs'));
  await assert.rejects(packageWindows(options), /ENOENT/);
  await writeJson('apps/desktop/electron/code-verification.cjs', {}); // Fixture host bytes are not executed.
  await rm(join(root, 'apps/desktop/electron/studio-key-vault.cjs'));
  await assert.rejects(packageWindows(options), /ENOENT/);
  await writeJson('apps/desktop/electron/studio-key-vault.cjs', {}); // Fixture host bytes are not executed.
  await rm(join(root, 'apps/desktop/electron/workspace-preferences.cjs'));
  await assert.rejects(packageWindows(options), /ENOENT/);
  await writeJson('apps/desktop/electron/workspace-preferences.cjs', {});
  await rm(join(root, 'apps/desktop/electron/provider-login.cjs'));
  await assert.rejects(packageWindows(options), /ENOENT/);
  await writeJson('apps/desktop/electron/provider-login.cjs', {});
  await rm(join(root, 'apps/desktop/electron/preload.cjs'));
  await assert.rejects(packageWindows(options), /ENOENT/);
  await writeJson('apps/desktop/electron/preload.cjs', {}); // Fixture host bytes are not executed.
  await rm(join(root, 'node_modules/helper-a/package.json'));
  await assert.rejects(packageWindows(options), /ENOENT/);
  await writeJson('node_modules/helper-a/package.json', { name: 'helper-a', version: '9.0.0' });
  await assert.rejects(packageWindows(options), /differs from lock/);
  await writeJson('node_modules/helper-a/package.json', { name: 'helper-a', ...locked['node_modules/helper-a'] });
  await writeJson('node_modules/zod/package.json', { name: 'zod', version: '4.6.6', dependencies: { stolen: '^1' } });
  await assert.rejects(packageWindows(options), /edges differ from lock/);
});

test('stale compiled sources remain gated by createLocalRelease provenance', async t => {
  const { write, options } = await fixture(t);
  await write('apps/desktop/src/workspace-shell.ts', 'export const changed = true;\n');
  await assert.rejects(packageWindows(options), /Compiled source is stale/);
});

test('Studio key controller compiled output is a required part of the release closure', async t => {
  const { root, options } = await fixture(t);
  await rm(join(root, 'dist/apps/desktop/src/studio-key-settings.js'));
  await assert.rejects(packageWindows(options), /missing dist\/apps\/desktop\/src\/studio-key-settings\.js/);
});

test('hardlinks, junctions and symlinks cannot redirect packaging or verification', async t => {
  const { root, write, options } = await fixture(t);
  await write('toolchains/original.exe', pe());
  await rm(options.nodeExecutable); await link(join(root, 'toolchains/original.exe'), options.nodeExecutable);
  await assert.rejects(packageWindows(options), /single-link file/);
  await rm(options.nodeExecutable); await write('toolchains/node/node.exe', pe());
  const result = await packageWindows(options);
  await link(join(result.directory, 'Arcane.exe'), join(root, 'toolchains/hardlink.exe'));
  await assert.rejects(verifyWindowsBundle(result.directory), /single-link file/);
  const target = join(root, 'runtime/windows');
  // Windows junctions need no Developer Mode; actual symlinks are covered on POSIX.
  const redirect = join(root, 'redirect');
  await symlink(target, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyWindowsBundle(join(redirect, result.directory.split(sep).at(-1))), /unredirected/);
});

test('optional host icon is copied only when present; unknown Electron payloads are refused', async t => {
  const { root, write, options } = await fixture(t);
  await rm(join(root, 'apps/desktop/electron/icon.png'));
  const result = await packageWindows(options);
  assert.ok(!(await manifest(result.directory)).files.some(file => file.path === 'resources/app/icon.png'));
  await write('toolchains/electron/dist/resources/app.asar', 'Unexpected alternate application.');
  await assert.rejects(packageWindows(options), /Unexpected Electron distribution payload/);
});


test('host code must equal its source snapshot even if an outer file descriptor is rehashed', async t => {
  const { options } = await fixture(t);
  for (const path of ['resources/app/policy.cjs', 'resources/app/code-verification.cjs', 'resources/app/provider-login.cjs', 'resources/app/studio-key-vault.cjs', 'resources/app/workspace-preferences.cjs']) {
    const result = await packageWindows(options), bytes = Buffer.from('// Changed host policy fixture.\n');
    await writeFile(join(result.directory, path), bytes);
    await mutateManifest(result.directory, data => {
      const entry = data.files.find(file => file.path === path);
      data.totalBytes += bytes.length - entry.bytes;
      entry.bytes = bytes.length; entry.sha256 = hash(bytes);
    });
    await assert.rejects(verifyWindowsBundle(result.directory), /Host differs from the verified product snapshot/);
  }
});


test('key-format parser markers are not material, but actual encoded and unfinished private-key bodies are refused', () => {
 assert.equal(hasPrivateKeyMaterial("pem.includes('-----BEGIN PRIVATE KEY-----')"),false);
 assert.equal(hasPrivateKeyMaterial('-----BEGIN PRIVATE KEY-----'),false);
 for(const format of ['','RSA ','EC ','DSA ','ENCRYPTED ','OPENSSH ']) for(const newline of ['\n','\\n','\\\\n']) assert.equal(hasPrivateKeyMaterial('-----BEGIN '+format+'PRIVATE KEY-----'+newline+'A'.repeat(64)),true);
});

test('production runtime, cache and generated code are not private Arcane runtime state',async t=>{
  const {write,options}=await fixture(t);
  for(const dir of ['runtime','cache','generated'])
    await write('node_modules/helper-a/dist/'+dir+'/required.js','module.exports = 42;');
  await write('runtime/product/private.txt','private Arcane state');
  const result=await packageWindows(options),data=await manifest(result.directory);
  for(const dir of ['runtime','cache','generated'])
    assert.ok(data.files.some(f=>f.path==='resources/product/node_modules/helper-a/dist/'+dir+'/required.js'));
  assert.ok(data.files.every(f=>!f.path.includes('resources/product/runtime/')));
  await verifyWindowsBundle(result.directory);
});
