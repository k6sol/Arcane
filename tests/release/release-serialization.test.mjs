import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('offline CI retains every suite and serializes filesystem integrity fixtures', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const phases = pkg.scripts.test.split(' && ');
  assert.deepEqual(phases, [
    'npm run build',
    'node --test --test-concurrency=1 dist/tests/unit/*.test.js',
    'node --test tests/skills/*.test.mjs',
    'node --test --test-concurrency=1 tests/release/*.test.mjs',
  ]);
  // The native verifier intentionally pins ancestor inode/mode/link counts.
  // Parallel fixture processes create/remove siblings in shared TEMP ancestors.
  // Serialize the tests, not the production predicate or its integrity checks.
  const checker = await readFile(new URL('../../scripts/managed-luau-compiler.mjs', import.meta.url), 'utf8');
  assert.match(checker, /\['dev', 'ino', 'mode', 'nlink'\]/);
  assert.match(checker, /checkChain\(chain\)/);
});
