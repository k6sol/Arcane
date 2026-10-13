import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const compile = process.env.ARCANE_LUAU_COMPILE ?? (runtime ? path.join(path.dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile') : undefined);
const modules = ['Validation', 'Registry', 'Properties', 'Operations'];

test('geometry property sources and scoped fixture compile with the official Luau compiler', { skip: !compile }, async () => {
  for (const filename of [...modules.map(name => `plugin/src/${name}.luau`), 'plugin/fixtures/MockEngine.luau', 'plugin/fixtures/Properties.spec.luau']) {
    const result = spawnSync(compile, ['--null', path.join(repository, filename)], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${filename}\n${result.stdout}\n${result.stderr}`);
  }
});

test('real Luau proves geometry mutation, enum validation, exact receipts and restoration against explicit doubles', { skip: !runtime }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-property-fixture-'));
  try {
    const sources = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(async name => `local ${name} = (function()\n${(await readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')).replace(/require\(script\.Parent\.([A-Za-z]+)\)/g, '$1')}\nend)()\n`),
      readFile(path.join(repository, 'plugin/fixtures/Properties.spec.luau'), 'utf8'),
    ]);
    const harness = path.join(directory, 'properties.luau');
    await writeFile(harness, sources.join('\n'));
    const result = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Arcane property checks passed: \d+/);
    process.stdout.write(result.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('arcane-property-fixture-'));
    await rm(directory, { recursive: true, force: true });
  }
});
