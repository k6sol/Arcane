// Exercise the production installer only against disposable folders, never Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildPlugin, PLUGIN_SOURCES } from '../../scripts/build-plugin.mjs';
import { installPlugin } from '../../scripts/install-plugin.mjs';

const sourceRoot = fileURLToPath(new URL('../../plugin/src/', import.meta.url));
async function fixture(t) {
  const boundary = await realpath(tmpdir()), repository = await mkdtemp(join(boundary, 'arcane-plugin-install-'));
  t.after(async () => {
    const part = relative(boundary, repository);
    assert.ok(part.startsWith('arcane-plugin-install-') && !isAbsolute(part) && !part.includes(sep));
    await rm(repository, { recursive: true, force: true });
  });
  const sourceDir = join(repository, 'plugin', 'src'), outDir = join(repository, 'plugin', 'build');
  await mkdir(sourceDir, { recursive: true });
  for (const [, , filename] of PLUGIN_SOURCES) await copyFile(join(sourceRoot, filename), join(sourceDir, filename));
  const build = await buildPlugin({ sourceDir, outDir });
  const installDirectory = join(repository, 'disposable-plugins');
  return { repository, installDirectory, build, sourceDir, outDir, options: { repository, installDirectory } };
}

test('production installer delivers the modular hierarchy and repeating it is unchanged', async t => {
  const f = await fixture(t), result = await installPlugin(f.options);
  assert.equal(result.target, join(f.installDirectory, 'ArcaneLocalBridge.rbxmx'));
  assert.equal(result.changed, true); assert.equal(result.studioReloadRequired, true);
  assert.equal(await readFile(result.target, 'utf8'), f.build.xml);
  assert.equal(createHash('sha256').update(await readFile(result.target)).digest('hex'), result.sha256);
  assert.equal((await installPlugin(f.options)).changed, false);
  await assert.rejects(access(join(f.installDirectory, 'ArcaneLocalBridge.lua')), { code: 'ENOENT' });
});

test('legacy Lua and XML aliases are backed up outside the active plugin folder', async t => {
  const f = await fixture(t); await mkdir(f.installDirectory);
  const originals = new Map([['ArcaneLocalBridge.lua', f.build.lua], ['ArcaneLocalBridge.rbxm', f.build.xml]]);
  for (const [name, bytes] of originals) await writeFile(join(f.installDirectory, name), bytes);
  await writeFile(join(f.installDirectory, 'OtherPlugin.lua'), '-- Preserve unrelated plugins.');
  const result = await installPlugin(f.options);
  assert.equal(result.migrated.length, 2);
  for (const entry of result.migrated) {
    assert.equal(dirname(entry.backup), join(f.repository, 'runtime', 'plugin-backups'));
    assert.equal(await readFile(entry.backup, 'utf8'), originals.get(entry.from.split(sep).at(-1)));
    await assert.rejects(access(entry.from), { code: 'ENOENT' });
  }
  assert.equal(await readFile(join(f.installDirectory, 'OtherPlugin.lua'), 'utf8'), '-- Preserve unrelated plugins.');
  assert.equal((await installPlugin(f.options)).changed, false);
});

test('an unrelated legacy filename refuses installation before moving any old artifact', async t => {
  const f = await fixture(t); await mkdir(f.installDirectory);
  await writeFile(join(f.installDirectory, 'ArcaneLocalBridge.lua'), f.build.lua);
  await writeFile(join(f.installDirectory, 'ArcaneLocalBridge.rbxm'), 'Unrelated content.');
  await assert.rejects(installPlugin(f.options), /different plugin/);
  assert.equal(await readFile(join(f.installDirectory, 'ArcaneLocalBridge.lua'), 'utf8'), f.build.lua);
  assert.equal(await readFile(join(f.installDirectory, 'ArcaneLocalBridge.rbxm'), 'utf8'), 'Unrelated content.');
  await assert.rejects(access(join(f.installDirectory, 'ArcaneLocalBridge.rbxmx')), { code: 'ENOENT' });
});

test('tampered builds and removed source descriptors cannot pass install preflight', async t => {
  const f = await fixture(t), manifestPath = join(f.outDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.sources.pop();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await assert.rejects(installPlugin(f.options), /stale/);
  await assert.rejects(access(f.installDirectory), { code: 'ENOENT' });
  await buildPlugin({ sourceDir: f.sourceDir, outDir: f.outDir });
  await writeFile(join(f.outDir, 'ArcaneLocalBridge.rbxmx'), f.build.xml + '<!-- tampered -->');
  await assert.rejects(installPlugin(f.options), /stale/);
  await assert.rejects(access(f.installDirectory), { code: 'ENOENT' });
});
