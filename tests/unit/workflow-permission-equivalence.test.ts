import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { parsePrivateReceiptDescriptor } from '../../apps/daemon/src/workflow-private-storage.js';
import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';
import { privatePermissionTraceScript, tracePrivatePermissions } from './windows-private-permission-fixture.js';

test('permission diagnostic is read-only metadata and cannot grant a private receipt descriptor', () => {
  for (const write of ['CreateDirectory', 'SetAccessControl', 'Set-Acl', 'SetOwner', 'SetTokenInformation', 'AdjustTokenPrivileges', 'ReadAllBytes', 'File]::Open'])
    assert.equal(privatePermissionTraceScript.includes(write), false, write);
  assert.ok(privatePermissionTraceScript.includes('$identity.Owner.Value'));
  assert.ok(privatePermissionTraceScript.includes('$identity.User.Value'));
  assert.ok(privatePermissionTraceScript.includes('if($reparse){return'));
  assert.ok(privatePermissionTraceScript.includes('$ancestors.Count -ge 32'));
  assert.ok(privatePermissionTraceScript.includes('$rules.Count -gt 256'));
  assert.throws(() => parsePrivateReceiptDescriptor({ version: 1, tokenOwnerIsUser: true, ancestors: [], directory: {}, key: {} }, true, false), { code: 'WORKFLOW_RECEIPT_STORAGE' });
});

test('native failure observation forwards the exact command/result, runs one bounded read-only trace and never retries', t => {
  const parent = resolve('runtime/verification/permission-observer-boundary-double');
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const calls: { command: string; args: readonly string[]; options: childProcess.SpawnSyncOptionsWithStringEncoding }[] = [];
  const failure: childProcess.SpawnSyncReturns<string> = { pid: 0, status: 1, signal: null, stdout: '', stderr: 'Arcane private workflow storage unavailable.', output: [null, '', 'Arcane private workflow storage unavailable.'] };
  // Isolated component DOUBLE: never replace the process's native spawn function.
  const boundary = { spawnSync: (command: string, args: readonly string[], options: childProcess.SpawnSyncOptionsWithStringEncoding) => {
    calls.push({ command, args, options });
    return failure;
  } };
  const compiled = readFileSync(new URL('./windows-private-permission-fixture.js', import.meta.url), 'utf8').replace(/^import[^;]+;\r?\n/gm, '').replace(/^export /gm, '');
  const observe = new Script(compiled + '\nobservePrivatePermissionRefusal;').runInNewContext({
    childProcess: boundary, existsSync: () => false, lstatSync: () => { throw new Error('No native filesystem in the boundary double.'); },
    realpathSync: { native: () => { throw new Error('No native filesystem in the boundary double.'); } },
    syncBuiltinESMExports: () => undefined, join, process, performance, Buffer, JSON,
  }) as (context: test.TestContext, root: string) => () => void;
  const close = observe(t, parent);
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'BOUNDARY DOUBLE ONLY'];
  const options: childProcess.SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8', env: { ARCANE_WORKFLOW_ACL_ROOT: parent, ARCANE_WORKFLOW_ACL_PREPARE: '1', ARCANE_WORKFLOW_ACL_KEY: '0' } };
  try {
    assert.equal(boundary.spawnSync(executable, args, options), failure);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.args, args); assert.equal(calls[0]!.options, options);
    assert.equal(calls[1]!.command, executable); assert.equal(calls[1]!.args[4], privatePermissionTraceScript);
    assert.equal(calls[1]!.options.timeout, 5_000); assert.equal(calls[1]!.options.maxBuffer, 16_384);
    assert.equal(calls[1]!.options.shell, false); assert.equal(calls[1]!.options.windowsHide, true);
    assert.equal(boundary.spawnSync(executable, args, options), failure);
    assert.equal(calls.length, 3, 'No second trace and no production retry.');
    const foreign = { ...options, env: { ...options.env, ARCANE_WORKFLOW_ACL_ROOT: parent + '-foreign' } };
    assert.equal(boundary.spawnSync(executable, args, foreign), failure);
    assert.equal(calls.length, 4, 'Foreign native calls are forwarded unchanged.');
    assert.equal(calls[3]!.options, foreign);
  } finally { close(); }
});

test('real Windows token/default-owner metadata agrees for fresh fixture directory and key without changing either', { skip: process.platform !== 'win32', timeout: 15_000 }, t => {
  const root = makeFixtureDirectory('arcane-token-owner-equivalence-');
  const directory = join(root, 'workflow-human-receipts'), key = join(directory, 'key-v1');
  mkdirSync(directory); writeFileSync(key, randomBytes(32), { flag: 'wx', mode: 0o600 });
  t.after(() => {
    const part = relative(fixtureTempDirectory(), resolve(root));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    assert.equal(lstatSync(root).isSymbolicLink(), false); rmSync(root, { recursive: true, force: true });
  });
  const fingerprint = (path: string) => {
    const s = lstatSync(path); return { dev: s.dev, ino: s.ino, nlink: s.nlink, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
  };
  const before = { directory: fingerprint(directory), key: fingerprint(key) };
  const first = tracePrivatePermissions(root), second = tracePrivatePermissions(root);
  assert.equal(first.status, 0); assert.equal(first.errorCode, null); assert.equal(first.signal, null);
  assert.deepEqual(second, first, 'Repeated metadata inspection must preserve the ACL observations.');
  const report = first.report as { tokenOwnerIsUser: boolean; tokenOwnerIsAdministrators: boolean; directory: { ownerIsTokenDefault: boolean; ownerIsUser: boolean }; key: { ownerIsTokenDefault: boolean; ownerIsUser: boolean } };
  assert.equal(typeof report.tokenOwnerIsUser, 'boolean');
  assert.equal(report.directory.ownerIsTokenDefault, true); assert.equal(report.key.ownerIsTokenDefault, true);
  assert.equal(report.directory.ownerIsUser, report.tokenOwnerIsUser); assert.equal(report.key.ownerIsUser, report.tokenOwnerIsUser);
  assert.deepEqual({ directory: fingerprint(directory), key: fingerprint(key) }, before);
  assert.throws(() => parsePrivateReceiptDescriptor(first.report, true, false), { code: 'WORKFLOW_RECEIPT_STORAGE' });
  t.diagnostic('WINDOWS_TOKEN_OWNER_EQUIVALENCE ' + JSON.stringify(first));
});
