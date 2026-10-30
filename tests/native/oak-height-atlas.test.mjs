import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, resolve } from 'node:path';

test('height-aware oak atlas contracts execute without skips in pinned Blender', { timeout: 65000 }, async () => {
  const executable = process.env.ARCANE_TEST_BLENDER_EXECUTABLE;
  assert.ok(typeof executable === 'string' && isAbsolute(executable));
  assert.equal(process.env.ARCANE_TEST_BLENDER_VERSION, '5.2.3');
  const { stdout } = await promisify(execFile)(executable, ['--background', '--factory-startup', '--disable-autoexec',
    '--python-exit-code', '1', '--python', resolve('tests/native/oak-height-atlas.py')],
  { timeout: 60000, maxBuffer: 65536, windowsHide: true });
  const line = stdout.split(/\r?\n/).find(row => row.startsWith('ARCANE_OAK_HEIGHT_ATLAS_OK '));
  assert.ok(line);
  const result = JSON.parse(line.slice('ARCANE_OAK_HEIGHT_ATLAS_OK '.length));
  assert.equal(result.cases, 9); assert.match(result.blender, /^5\.2\.3\b/);
});
