import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, lstatSync, realpathSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const own = dirname(fileURLToPath(import.meta.url));
// A unique package-local output tree: never share root dist or another agent's
// compiler outputs. No npm, dependency install, native executable or inference.
for (let path = own; ; path = dirname(path)) {
  const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe check root');
  if (path === dirname(path)) break;
}
if (realpathSync(own).toLowerCase() !== own.toLowerCase()) throw new Error('Redirected check root');
const checks = join(own, '.checks');
try { const stat = lstatSync(checks); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe output root'); }
catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(checks); }
const output = mkdtempSync(join(checks, 'run-'));
const compile = spawnSync(process.execPath, [resolve(own, '../../node_modules/typescript/bin/tsc'), '-p', join(own, 'tsconfig.check.json'), '--outDir', output],
  { cwd: own, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
writeFileSync(join(output, 'compile.log'), (compile.stdout ?? '') + (compile.stderr ?? ''), { flag: 'wx' });
if (compile.status !== 0) { process.stderr.write((compile.stdout ?? '') + (compile.stderr ?? '')); process.exit(1); }
const tests = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=15000', '--test-reporter=tap',
  join(output, 'tests/controller.test.js'), join(output, 'tests/native-adapter.test.js')],
  { cwd: own, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
process.stdout.write(tests.stdout ?? ''); process.stderr.write(tests.stderr ?? '');
const tap = (tests.stdout ?? '') + (tests.stderr ?? '');
writeFileSync(join(output, 'regression.tap'), tap, { flag: 'wx' });
const inputs = ['package.json', 'tsconfig.check.json', 'run-tests.mjs', ...['src', 'tests'].flatMap(directory =>
  readdirSync(join(own, directory)).filter(name => name.endsWith('.ts')).map(name => directory + '/' + name))];
const summary = { evidence: 'SDK-in-memory-fixtures-only', realStudioCalls: 0, nativeAcceptance: false,
  compilerExit: compile.status, testsExit: tests.status, isolatedOutput: output,
  tests: Number(tap.match(/^# tests (\d+)/m)?.[1] ?? 0), passed: Number(tap.match(/^# pass (\d+)/m)?.[1] ?? 0), failed: Number(tap.match(/^# fail (\d+)/m)?.[1] ?? 0),
  inputs: Object.fromEntries(inputs.map(path => [path, createHash('sha256').update(readFileSync(join(own, path))).digest('hex')])) };
writeFileSync(join(output, 'results.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(summary));
process.exitCode = tests.status === 0 ? 0 : 1;
