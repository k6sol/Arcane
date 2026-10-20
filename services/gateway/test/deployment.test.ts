// Conservative manifest/dependency check, not an execution of Docker's builder or image acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, lstatSync, realpathSync} from 'node:fs';
import {dirname, resolve, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
test('gateway build context admits only fixed regular source files and all runtime imports remain inside it', () => {
  const rules = readFileSync(resolve(root, 'services/gateway/Dockerfile.dockerignore'), 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.equal(rules.shift(), '**', 'deny the complete context before explicit file exceptions');
  const files = rules.map(rule => {assert.match(rule, /^!(?:services\/gateway\/(?:package\.json|src\/[a-z-]+\.ts)|packages\/diagnostics\/src\/report\.ts)$/); return rule.slice(1);});
  assert.equal(new Set(files).size, files.length);
  const admitted = new Set(files);
  for (const secret of ['.git/config', '.env', '.npmrc', 'runtime/private.json', 'services/gateway/.env', 'services/gateway/data/gateway.sqlite',
    'services/gateway/src/secret.env', 'services/gateway/src/private-key.pem', 'services/gateway/src/unreviewed.ts', 'packages/diagnostics/src/outbox.ts']) assert.ok(!admitted.has(secret));
  assert.ok(admitted.has('services/gateway/package.json')); assert.ok(admitted.has('services/gateway/src/main.ts')); assert.ok(admitted.has('packages/diagnostics/src/report.ts'));
  for (const file of files) {
    const absolute = resolve(root, file); assert.equal(realpathSync(absolute).toLowerCase(), absolute.toLowerCase());
    const stat = lstatSync(absolute); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!; if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), 'gateway needs no installed third-party runtime modules');
      const imported = relative(root, resolve(dirname(absolute), specifier)).split(sep).join('/');
      assert.ok(admitted.has(imported), file + ' imports a file absent from the closed build context: ' + imported);
    }
  }
  const dockerfile = readFileSync(resolve(root, 'services/gateway/Dockerfile'), 'utf8');
  const copies = dockerfile.split(/\r?\n/).filter(line => /^COPY\s/.test(line));
  assert.deepEqual(copies, ['COPY services/gateway/package.json ./', 'COPY services/gateway/src ./src', 'COPY packages/diagnostics/src/report.ts /app/packages/diagnostics/src/report.ts']);
  assert.ok(!/^ADD\s/im.test(dockerfile), 'no unreviewed remote/local ADD instructions');
});
