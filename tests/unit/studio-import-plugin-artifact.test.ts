import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { studioImportPluginArtifactHash } from '../../apps/daemon/src/studio-import-plugin-artifact.js';

// Synthetic fixed resource bytes only; never execute or install plugin source.
async function fixture(t: test.TestContext) {
  const boundary = await realpath(tmpdir()), root = await mkdtemp(join(boundary, 'arcane-import-plugin-'));
  const directory = join(root, 'plugin', 'build'); await mkdir(directory, { recursive: true });
  t.after(async () => {
    const part = relative(boundary, root); assert.ok(part.startsWith('arcane-import-plugin-') && !isAbsolute(part) && !part.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const source = Buffer.from('local fixture = {"scene.import_context"}\n'), hash = createHash('sha256').update(source).digest('hex');
  const artifact = { name: 'ArcaneLocalBridge.lua', format: 'luau-source', bytes: source.length, sha256: hash };
  const manifest = { schemaVersion: 1, protocolVersion: 1, preferredArtifact: 'ArcaneLocalBridge.lua', artifacts: [artifact] };
  const save = async () => writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'ArcaneLocalBridge.lua'), source); await save();
  return { root, directory, source, hash, manifest, save };
}
test('bundled current-capability bytes must match the preferred build hash and length', async t => {
  const f = await fixture(t); assert.equal(await studioImportPluginArtifactHash(f.root), f.hash);
});
test('modified source and duplicate preferred artifacts are refused', async t => {
  const f = await fixture(t); await writeFile(join(f.directory, 'ArcaneLocalBridge.lua'), Buffer.concat([f.source, Buffer.from('-- changed')]));
  await assert.rejects(studioImportPluginArtifactHash(f.root), { code: 'STUDIO_IMPORT_PLUGIN' });
  await writeFile(join(f.directory, 'ArcaneLocalBridge.lua'), f.source); f.manifest.artifacts.push({ ...f.manifest.artifacts[0]! }); await f.save();
  await assert.rejects(studioImportPluginArtifactHash(f.root), { code: 'STUDIO_IMPORT_PLUGIN' });
});
test('a matching old build without import context cannot enable import preparation', async t => {
  const f = await fixture(t), source = Buffer.from('-- Synthetic old plugin build\n');
  await writeFile(join(f.directory, 'ArcaneLocalBridge.lua'), source);
  f.manifest.artifacts[0]!.sha256 = createHash('sha256').update(source).digest('hex'); f.manifest.artifacts[0]!.bytes = source.length; await f.save();
  await assert.rejects(studioImportPluginArtifactHash(f.root), { code: 'STUDIO_IMPORT_PLUGIN' });
});
