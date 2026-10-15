import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { studioImportPluginArtifactHash } from '../../apps/daemon/src/studio-import-plugin-artifact.js';
import { STUDIO_PLUGIN_SOURCES, STUDIO_PLUGIN_IDENTITY_SCHEME } from '../../packages/protocol/src/studio-plugin-artifact.js';

// Synthetic fixed resource bytes only; never execute or install plugin source.
async function fixture(t: test.TestContext) {
  const boundary = await realpath(tmpdir()), root = await mkdtemp(join(boundary, 'arcane-import-plugin-'));
  const directory = join(root, 'plugin', 'build'); await mkdir(directory, { recursive: true });
  await mkdir(join(root, 'plugin', 'src'));
  t.after(async () => {
    const part = relative(boundary, root); assert.ok(part.startsWith('arcane-import-plugin-') && !isAbsolute(part) && !part.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const source = Buffer.from('<?xml version="1.0"?><roblox version="4"><Item class="Script"><Properties><ProtectedString name="Source"><![CDATA[local fixture = {"scene.import_context"}\n]]></ProtectedString></Properties></Item></roblox>');
  const artifact = { name: 'ArcaneLocalBridge.rbxmx', format: 'roblox-xml-v4', bytes: source.length, sha256: createHash('sha256').update(source).digest('hex') };
  const sources = [], identities = [];
  for (const [name, , filename] of STUDIO_PLUGIN_SOURCES) {
    const text = '--!strict\n-- Synthetic ' + name + '\nreturn {}\n';
    const sha256 = createHash('sha256').update(text).digest('hex');
    await writeFile(join(root, 'plugin', 'src', filename), text);
    sources.push({ path: 'src/' + filename, bytes: Buffer.byteLength(text), sha256 });
    identities.push(name + '\0' + sha256);
  }
  const hash = createHash('sha256').update(STUDIO_PLUGIN_IDENTITY_SCHEME + '\n' + identities.join('\n') + '\n').digest('hex');
  const manifest = { schemaVersion: 1, protocolVersion: 1, preferredArtifact: 'ArcaneLocalBridge.rbxmx', sources,
    runtimeIdentity: { scheme: STUDIO_PLUGIN_IDENTITY_SCHEME, sha256: hash }, artifacts: [artifact] };
  const save = async () => writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'ArcaneLocalBridge.rbxmx'), source); await save();
  return { root, directory, source, hash, manifest, save };
}
test('bundled current-capability bytes must match the preferred build hash and length', async t => {
  const f = await fixture(t); assert.equal(await studioImportPluginArtifactHash(f.root), f.hash);
});
test('modified source and duplicate preferred artifacts are refused', async t => {
  const f = await fixture(t); await writeFile(join(f.directory, 'ArcaneLocalBridge.rbxmx'), Buffer.concat([f.source, Buffer.from('-- changed')]));
  await assert.rejects(studioImportPluginArtifactHash(f.root), { code: 'STUDIO_IMPORT_PLUGIN' });
  await writeFile(join(f.directory, 'ArcaneLocalBridge.rbxmx'), f.source); f.manifest.artifacts.push({ ...f.manifest.artifacts[0]! }); await f.save();
  await assert.rejects(studioImportPluginArtifactHash(f.root), { code: 'STUDIO_IMPORT_PLUGIN' });
});
test('a matching old build without import context cannot enable import preparation', async t => {
  const f = await fixture(t), source = Buffer.from('-- Synthetic old plugin build\n');
  await writeFile(join(f.directory, 'ArcaneLocalBridge.rbxmx'), source);
  f.manifest.artifacts[0]!.sha256 = createHash('sha256').update(source).digest('hex'); f.manifest.artifacts[0]!.bytes = source.length; await f.save();
  await assert.rejects(studioImportPluginArtifactHash(f.root), { code: 'STUDIO_IMPORT_PLUGIN' });
});

test('a legacy single-script preference cannot authorize the modular import capability', async t => {
  const f = await fixture(t);
  const manifest = { ...f.manifest, preferredArtifact: 'ArcaneLocalBridge.lua', artifacts: [{ ...f.manifest.artifacts[0], name: 'ArcaneLocalBridge.lua', format: 'luau-source' }] };
  await writeFile(join(f.directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(f.directory, 'ArcaneLocalBridge.lua'), f.source);
  await assert.rejects(studioImportPluginArtifactHash(f.root), { code: 'STUDIO_IMPORT_PLUGIN' });
});

test('every packaged module and the declared source identity are verified', async t => {
  const f = await fixture(t);
  const module = join(f.root, 'plugin', 'src', 'AssetUpload.luau');
  await writeFile(module, '--!strict\n-- Changed child module.\nreturn {}\n');
  await assert.rejects(studioImportPluginArtifactHash(f.root), { code: 'STUDIO_IMPORT_PLUGIN' });
});

test('a matching artifact cannot substitute an unrecognized runtime identity scheme', async t => {
  const f = await fixture(t); f.manifest.runtimeIdentity.scheme = 'unknown-scheme'; await f.save();
  await assert.rejects(studioImportPluginArtifactHash(f.root), { code: 'STUDIO_IMPORT_PLUGIN' });
});
