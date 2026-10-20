import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WORKER_PACKAGES, workerSourcePath } from '../../packages/asset-pipeline/src/validation.js';

const WORKERS = resolve('workers/blender');
const python = (directory: string) => readdirSync(directory).filter(name => name.endsWith('.py')).sort();
const subpackages = readdirSync(WORKERS, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !/^[._]/.test(entry.name) && python(join(WORKERS, entry.name)).length).map(entry => entry.name).sort();

test('every workers/blender subpackage is registered for job staging with exactly its modules', () => {
  // A new worker directory (or a module added to one) must be staged into jobs, or Blender fails on import.
  assert.deepEqual(Object.keys(WORKER_PACKAGES).sort(), subpackages);
  for (const directory of subpackages) {
    const files = python(join(WORKERS, directory));
    const staged = files.includes('__init__.py') ? [directory + '.py'] : files;
    assert.deepEqual([...WORKER_PACKAGES[directory]!].sort(), staged, directory);
  }
});

test('staged worker names are flat, unique and resolve to their repository source', () => {
  const top = python(WORKERS), seen = new Set(top);
  for (const [directory, names] of Object.entries(WORKER_PACKAGES)) {
    for (const name of names) {
      assert.ok(!seen.has(name), 'duplicate flat worker module ' + name); seen.add(name);
      const source = workerSourcePath(name);
      assert.equal(source[0], directory);
      assert.ok(existsSync(join(WORKERS, ...source)), name);
    }
  }
  assert.deepEqual(workerSourcePath('procedural.py'), ['procedural.py']);
  assert.deepEqual(workerSourcePath('variation.py'), ['variation', '__init__.py']);
});
