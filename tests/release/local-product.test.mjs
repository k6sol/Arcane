import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalRelease, verifyLocalRelease } from '../../scripts/create-local-release.mjs';
import { productDoctor } from '../../scripts/product-doctor.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'arcane-release-test-'));
  t.after(async () => {
    const full = resolve(root), boundary = resolve(tmpdir()), path = relative(boundary, full);
    assert.ok(path.startsWith('arcane-release-test-') && !path.includes(sep) && !isAbsolute(path));
    assert.equal((await lstat(full)).isSymbolicLink(), false);
    await rm(full, { recursive: true, force: true });
  });
  for (const dir of ['apps', 'packages', 'workers', 'plugin', 'scripts', 'skills', 'docs', 'tests', 'dist', '.github']) await mkdir(join(root, dir));
  const write = async (path, value) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), value); };
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json']) await write(path, JSON.stringify({ name: 'arcane', version: '0.1.0', type: 'module' }));
  for (const path of ['README.md', 'LICENSE']) await write(path, 'Fixture content.\n');
  for (const path of ['dist/apps/daemon/src/product-main.js', 'dist/apps/mcp/src/main.js', 'dist/apps/desktop/src/studio.js', 'apps/desktop/public/studio.html', 'workers/blender/asset_worker.py']) await write(path, '// Test fixture only.\n');
  await write('skills/registry.json', '{}');
  const pluginSource = '--!strict\nlocal __arcaneFactories = {}\n';
  await write('plugin/src/Main.server.luau', pluginSource);
  await write('plugin/build/ArcaneLocalBridge.lua', pluginSource);
  await write('plugin/build/manifest.json', JSON.stringify({ schemaVersion: 1, preferredArtifact: 'ArcaneLocalBridge.lua', sources: [{ path: 'src/Main.server.luau', sha256: hash(pluginSource) }], artifacts: [{ name: 'ArcaneLocalBridge.lua', bytes: Buffer.byteLength(pluginSource), sha256: hash(pluginSource) }] }));
  return { root, write };
}

test('release snapshots compiled/source files and never copies runtime, tokens, dependencies or caches', async t => {
  const { root, write } = await fixture(t);
  await write('runtime/product/daemon.json', '{"token":"never-copy-me"}');
  await write('node_modules/private/auth.json', '{"access_token":"never-copy-me"}');
  await write('apps/mcp/generated/claude.mcp.json', '{"password":"never-copy-me"}');
  await write('packages/asset-pipeline/.runtime/job/log.txt', 'never-copy-me');
  await write('tests/.tmp/auth.json', '{}');
  const result = await createLocalRelease({ repository: root });
  assert.equal(result.dependencyInstallRequired, true); assert.equal(result.fullProductVerified, false);
  const manifest = JSON.parse(await readFile(join(result.directory, 'release-manifest.json'), 'utf8'));
  assert.ok(manifest.files.some(file => file.path === 'plugin/build/ArcaneLocalBridge.lua'));
  assert.ok(manifest.files.every(file => !/runtime|node_modules|generated|\.tmp/.test(file.path)));
  const verified = await verifyLocalRelease(result.directory);
  assert.equal(verified.signed, false); assert.equal(verified.runtimeVerified, false);
  await mkdir(join(result.directory, 'runtime')); await writeFile(join(result.directory, 'runtime', 'user-data.json'), '{}');
  await mkdir(join(result.directory, 'node_modules')); await writeFile(join(result.directory, 'node_modules', 'installed.json'), '{}');
  assert.deepEqual((await verifyLocalRelease(result.directory)).mutableRootsNotVerified, ['node_modules', 'runtime', 'apps/mcp/generated']);
});

test('integrity verification rejects modified, unlisted and traversal payloads', async t => {
  const { root } = await fixture(t);
  const { directory } = await createLocalRelease({ repository: root });
  await writeFile(join(directory, 'README.md'), 'Modified');
  await assert.rejects(verifyLocalRelease(directory), /checksum/);
  const other = await createLocalRelease({ repository: root });
  await writeFile(join(other.directory, 'unlisted.lua'), 'payload');
  await assert.rejects(verifyLocalRelease(other.directory), /Unlisted/);
  const third = await createLocalRelease({ repository: root });
  const path = join(third.directory, 'release-manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.files[0].path = '../../outside'; await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(verifyLocalRelease(third.directory), /Forbidden/);
});

test('actual key/session-link strings and credential-like JSON fields fail packaging', async t => {
  const { root, write } = await fixture(t);
  await write('docs/secret.md', 'arcane_local_v1_45871_' + 'a'.repeat(64));
  await assert.rejects(createLocalRelease({ repository: root }), /credential/);
  await write('docs/secret.md', 'http://127.0.0.1:45871/studio#' + 'a'.repeat(64));
  await assert.rejects(createLocalRelease({ repository: root }), /credential/);
  await write('docs/secret.md', 'Cleared'); await write('docs/secret.json', '{"refresh_token":"private"}');
  await assert.rejects(createLocalRelease({ repository: root }), /Credential-like/);
});

test('links and hardlinks cannot redirect release reads or outputs', async t => {
  const { root, write } = await fixture(t);
  await write('docs/target.md', 'target'); await link(join(root, 'docs/target.md'), join(root, 'docs/alias.md'));
  await assert.rejects(createLocalRelease({ repository: root }), /single-link/);
  const second = await fixture(t);
  await mkdir(join(second.root, 'outside'));
  try { await symlink(join(second.root, 'outside'), join(second.root, 'docs/linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('OS disallowed fixture link creation; hardlink rejection still proved.'); return; } throw error; }
  await assert.rejects(createLocalRelease({ repository: second.root }), /Link/);
});

test('build prerequisite failure is explicit and preflight never treats parent dependencies as local', async t => {
  const { root, write } = await fixture(t);
  const report = await productDoctor({ repository: root });
  assert.equal(report.credentialsRead, false); assert.equal(report.networkUsed, false); assert.equal(report.installsPerformed, false);
  assert.equal(report.readyToLaunch, false);
  assert.equal(report.checks.find(check => check.id === 'plugin-artifact').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'studio-runtime').status, 'unverified');
  assert.equal((await productDoctor({ repository: root, nodeVersion: '22.0.0' })).checks.find(check => check.id === 'node').status, 'fail');
  await write('plugin/src/Main.server.luau', '-- changed');
  assert.equal((await productDoctor({ repository: root })).checks.find(check => check.id === 'plugin-artifact').status, 'fail');
  await rm(join(root, 'dist/apps/daemon/src/product-main.js')); // Single explicitly named fixture file, no recursive deletion.
  await assert.rejects(createLocalRelease({ repository: root }), /Build the product/);
});
