// Verify the actual Main identity code in the standalone VM, never in Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PLUGIN_SOURCES, renderPlugin } from '../../scripts/build-plugin.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const files = await Promise.all(PLUGIN_SOURCES.map(async ([, , filename]) => ({ filename, source: await readFile(join(repository, 'plugin', 'src', filename), 'utf8') })));
const build = renderPlugin(files), main = build.sources[0].source;
const identityCode = main.slice(main.indexOf('local ARTIFACT_MODULES ='), main.indexOf('local artifactHash = loadedArtifactHash()'));
const runtime = process.env.ARCANE_LUAU_BIN, compile = process.env.ARCANE_LUAU_COMPILE;
const literal = bytes => '"' + Array.from(Buffer.from(bytes), byte => '\\' + String(byte).padStart(3, '0')).join('') + '"';

test('Main names exactly the declared child modules for its runtime identity', () => {
  const modules = /local ARTIFACT_MODULES = table\.freeze\(\{([^}]+)\}\)/.exec(identityCode);
  assert.ok(modules);
  assert.deepEqual([...modules[1].matchAll(/"([^"]+)"/g)].map(match => match[1]), PLUGIN_SOURCES.slice(1).map(([name]) => name));
  assert.equal(build.manifest.runtimeIdentity.scheme, 'arcane-plugin-source-v1');
  assert.match(build.manifest.runtimeIdentity.sha256, /^[a-f0-9]{64}$/);
});

test('loaded source identity matches the builder and detects changed, missing and unexpected modules', { skip: !runtime && 'Standalone Luau runtime not configured.', timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-artifact-identity-'));
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  await copyFile(join(repository, 'plugin', 'src', 'Sha256.luau'), join(directory, 'Sha256.luau'));
  const harness = join(directory, 'identity.luau');
  await writeFile(harness, `
local Sha256 = require("./Sha256")
local function instance(name: string, className: string, source: string): any
  local item: any = {Name = name, className = className, Source = source, children = {}}
  function item:IsA(expected: string): boolean return self.className == expected end
  function item:GetChildren(): {any} return self.children end
  return item
end
local script = instance("ArcaneLocalBridge", "Script", ${literal(build.sources[0].source)})
${build.sources.slice(1).map(source => `table.insert(script.children, instance(${JSON.stringify(source.name)}, "ModuleScript", ${literal(source.source)}))`).join('\n')}
local function typeof(value: any): string return if type(value) == "table" and value.className then "Instance" else type(value) end
${identityCode}
local expected = ${JSON.stringify(build.manifest.runtimeIdentity.sha256)}
assert(loadedArtifactHash() == expected, "actual loaded source hierarchy must match the builder identity")
local child = script.children[#script.children]
local original = child.Source
child.Source ..= "-- Changed child source.\\n"
assert(loadedArtifactHash() ~= expected, "changing a child must change the identity even when Main stays identical")
child.Source = utf8.char(0xFEFF) .. string.gsub(original, "\\n", "\\r\\n")
assert(loadedArtifactHash() == expected, "source normalization must agree across builder, daemon and VM")
child.Source = original
child.Name = "Unknown"
assert(loadedArtifactHash() == nil, "same-count unknown module must fail closed")
child.Name = "AssetUpload"
child.children = {instance("Unexpected", "ModuleScript", "")}
assert(loadedArtifactHash() == nil, "nested source cannot escape the inventory")
child.children = {}
table.remove(script.children)
assert(loadedArtifactHash() == nil, "missing module must fail closed")
table.insert(script.children, child)
table.insert(script.children, instance("Unknown", "ModuleScript", ""))
assert(loadedArtifactHash() == nil, "extra module must fail closed")
table.remove(script.children)
child.className = "Script"
assert(loadedArtifactHash() == nil, "a child Script cannot impersonate a ModuleScript")
child.className = "ModuleScript"
script.Name = "OtherPlugin"
assert(loadedArtifactHash() == nil, "a different root cannot impersonate Arcane")
print("modular artifact identity passed")
`);
  for (const [binary, args] of [...(compile ? [[compile, ['--null', harness]]] : []), [runtime, [harness]]]) {
    const result = spawnSync(binary, args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
