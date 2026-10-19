import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const compiler = process.env.ARCANE_LUAU_COMPILE;

test('real Luau: final-yaw OBB fit respects maxSize, floor pivot and receipt dimensions', { skip: !runtime }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-yaw-math-'));
  try {
    const fixture = await readFile(join(repository, 'tests/plugin/fixtures/asset-placement-yaw.luau'), 'utf8');
    const split = fixture.indexOf('local function runPlacement'); assert.ok(split > 0);
    const source = (await readFile(join(repository, 'plugin/src/AssetPlacement.luau'), 'utf8')).replace('local V = require(script.Parent.Validation)', '');
    const validation = 'local V: any = {array=function(v: any): any return v end, NULL={}}\n' +
      'function V.fail(code: string, message: string): never error({code=code,message=message}) end\n';
    const harness = fixture.slice(0, split) + validation + '\nlocal AssetPlacement = (function()\n' + source + '\nend)()\n' + fixture.slice(split);
    const path = join(directory, 'yaw.luau'); await writeFile(path, harness);
    if (compiler) {
      const compiled = spawnSync(compiler, ['--null', path], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    }
    const ran = spawnSync(runtime, [path], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.ifError(ran.error); assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /YAW_REGRESSION_OK 46 checks/);
  } finally {
    const path = relative(tmpdir(), directory);
    assert.ok(path.startsWith('arcane-yaw-math-') && !path.includes('..') && !isAbsolute(path));
    await rm(directory, { recursive: true, force: true });
  }
});
