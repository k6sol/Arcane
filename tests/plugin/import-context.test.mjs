import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildPlugin, PLUGIN_SOURCES, renderPlugin } from '../../scripts/build-plugin.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const compile = process.env.ARCANE_LUAU_COMPILE;
const proof = process.env.ARCANE_IMPORT_CONTEXT_PROOF_DIR;
const digest = value => createHash('sha256').update(value).digest('hex');
const modules = ['Validation', 'Registry', 'Properties', 'AssetMesh', 'Sha256Stream', 'AssetTransfer', 'Operations', 'Transport', 'TestProof'];
async function directory(label) {
  if (!proof) return mkdtemp(path.join(tmpdir(), `arcane-import-context-${label}-`));
  const dir = path.join(path.resolve(proof), label);
  await mkdir(dir, { recursive: true });
  return dir;
}
function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}

test('protocol and plugin expose import context only as a closed read capability', async () => {
  const [protocol, validation, operations, types] = await Promise.all([
    readFile(path.join(repository, 'packages/protocol/src/studio.ts'), 'utf8'),
    ...['Validation', 'Operations', 'Types'].map(name => readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')),
  ]);
  const list = (text, name) => [...text.match(new RegExp(`${name} = (?:table\\.freeze\\(\\{([^}]+)\\}\\)|\\[([^\\]]+)\\])`))[0].matchAll(/['"]([^'"]+)['"]/g)].map(value => value[1]);
  assert.deepEqual(list(protocol, 'READ_METHODS'), list(validation, 'READ_METHODS'));
  assert.deepEqual(list(protocol, 'WRITE_METHODS'), list(validation, 'WRITE_METHODS'));
  assert.ok(list(protocol, 'READ_METHODS').includes('scene.import_context'));
  assert.ok(!list(protocol, 'WRITE_METHODS').includes('scene.import_context'));
  assert.match(operations, /elseif method == "scene\.import_context" then result = self:importContext\(args\)/);
  assert.match(types, /export type StudioImportContextObservation/);
});

test('production context observation and transport receipts execute with standalone engine doubles',
  { skip: !runtime && 'Official standalone Luau VM not configured; native Studio remains pending.' }, async () => {
    const dir = await directory('runtime');
    const [engine, checks, ...sources] = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      readFile(path.join(repository, 'plugin/fixtures/ImportContext.spec.luau'), 'utf8'),
      ...modules.map(name => readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')),
    ]);
    const loader = `
local sourceModules, sourceCache = {}, {}
local script: any = {Parent = {}}
local function require(module: any): any
  if sourceCache[module.Name] == nil then sourceCache[module.Name] = sourceModules[module.Name]() end
  return sourceCache[module.Name]
end
local function contextRequire(name: string): any return require(script.Parent[name]) end
` + modules.map((name, index) => `script.Parent.${name} = {Name = "${name}"}\nsourceModules["${name}"] = function()\n${sources[index]}\nend\n`).join('\n');
    const harness = path.join(dir, 'import-context.luau');
    await writeFile(harness, `${engine}\n${loader}\n${checks}`);
    if (compile) await writeFile(path.join(dir, 'compile.log'), run(compile, ['--null', harness]));
    const output = run(runtime, [harness]);
    await writeFile(path.join(dir, 'runtime.log'), output);
    assert.match(output, /Arcane import context fixture passed: \d+ checks \(engine doubles only\)/);
    const receipts = [...output.matchAll(/^ARCANE_CONTEXT_WIRE ([a-z-]+) (.+)$/gm)].map(([, label, body]) => ({ label, body, receipt: JSON.parse(body) }));
    assert.equal(receipts.length, 6, 'published and local wire cases ran through the actual result POST');
    for (const { label, receipt } of receipts) {
      assert.equal(receipt.state, 'succeeded');
      assert.equal(receipt.sessionId, receipt.result.sessionId);
      assert.equal(receipt.sessionId, receipt.result.parentRef.sessionId);
      assert.ok(Object.hasOwn(receipt.result.creator, 'kind'));
      assert.ok(Object.hasOwn(receipt.result.studioUser, 'id'));
      if (label.startsWith('published-')) {
        assert.equal(receipt.result.studioUser.status, 'not_applicable');
        assert.equal(receipt.result.studioUser.id, null);
        assert.equal(receipt.result.placeId, 12);
        assert.equal(receipt.result.universeId, 34);
      } else {
        assert.equal(receipt.result.creator.status, 'unavailable');
        assert.equal(receipt.result.creator.kind, null);
        assert.equal(receipt.result.creator.id, 0);
        assert.equal(receipt.result.studioUser.id, label === 'local-available' ? 78 : null);
      }
      assert.equal(receipt.result.creator.provenance, 'game.CreatorType/CreatorId');
      assert.equal(receipt.result.studioUser.provenance, 'StudioService:GetUserId');
    }
    await writeFile(path.join(dir, 'wire-receipts.json'), JSON.stringify(receipts, null, 2) + '\n');
  });

test('private plugin artifacts render deterministically and compile without installing or replacing plugin/build', async () => {
  const dir = await directory('build');
  const sources = await Promise.all(PLUGIN_SOURCES.map(async ([, , filename]) => ({ filename, source: await readFile(path.join(repository, 'plugin/src', filename), 'utf8') })));
  const expected = renderPlugin(sources);
  const actual = await buildPlugin({ outDir: dir });
  assert.equal(actual.lua, expected.lua);
  assert.equal(actual.xml, expected.xml);
  assert.deepEqual(actual.manifest, expected.manifest);
  await buildPlugin({ outDir: dir, check: true });
  for (const artifact of actual.manifest.artifacts) {
    const bytes = await readFile(path.join(dir, artifact.name));
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(digest(bytes), artifact.sha256);
  }
  if (compile) {
    const paths = [];
    for (const source of actual.sources) {
      const target = path.join(dir, source.filename); await writeFile(target, source.source); paths.push(target);
    }
    const log = run(compile, ['--null', ...paths]);
    await writeFile(path.join(dir, 'compile.log'), log);
  }
  await writeFile(path.join(dir, 'verification.json'), JSON.stringify({ deterministic: true, compilerRan: Boolean(compile),
    installed: false, engineVerification: 'pending', note: 'Pure source rendering and offline compiler only.' }, null, 2) + '\n');
});
