import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, resolve } from 'node:path';

test('generated union and fallback meshes bind their sole authored material', { timeout: 65000 }, async () => {
  const executable = process.env.ARCANE_TEST_BLENDER_EXECUTABLE;
  assert.ok(typeof executable === 'string' && isAbsolute(executable));
  assert.equal(process.env.ARCANE_TEST_BLENDER_VERSION, '5.2.3');
  const { stdout } = await promisify(execFile)(executable, ['--background', '--factory-startup', '--disable-autoexec',
    '--python-exit-code', '1', '--python', resolve('tests/native/procedural_material_slots.py')],
  { timeout: 60000, maxBuffer: 65536, windowsHide: true });
  assert.match(stdout, /ARCANE_GENERATED_MATERIAL_SLOTS_OK /);
  const line = stdout.split(/\r?\n/).find(row => row.startsWith('ARCANE_GENERATED_MATERIAL_SLOTS_OK '));
  const result = JSON.parse(line.slice('ARCANE_GENERATED_MATERIAL_SLOTS_OK '.length));
  assert.equal(result.cases, 2);
  assert.equal(result.diagnosticCases, 1);
  assert.equal(result.oakSprayCases, 4);
  assert.match(result.blender, /^5\.2\.3\b/);
});
