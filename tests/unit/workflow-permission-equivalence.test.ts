import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { parsePrivateReceiptDescriptor } from '../../apps/daemon/src/workflow-private-storage.js';
import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';
import { nativeMetadataJsonSetup, privatePermissionTraceScript, tracePrivatePermissions } from './windows-private-permission-fixture.js';
import {ownerPolicyFixture as ownerFixture} from './windows-owner-policy-fixture.js';

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
  t.diagnostic('WINDOWS_TOKEN_OWNER_EQUIVALENCE ' + JSON.stringify({first,second}));
  assert.equal(first.status, 0); assert.equal(first.errorCode, null); assert.equal(first.signal, null);
  assert.deepEqual(second, first, 'Repeated metadata inspection must preserve the ACL observations.');
  const report = first.report as { tokenOwnerIsUser: boolean; tokenOwnerIsAdministrators: boolean; directory: { ownerIsTokenDefault: boolean; ownerIsUser: boolean }; key: { ownerIsTokenDefault: boolean; ownerIsUser: boolean } };
  assert.equal(typeof report.tokenOwnerIsUser, 'boolean');
  assert.equal(report.directory.ownerIsTokenDefault, true); assert.equal(report.key.ownerIsTokenDefault, true);
  assert.equal(report.directory.ownerIsUser, report.tokenOwnerIsUser); assert.equal(report.key.ownerIsUser, report.tokenOwnerIsUser);
  assert.deepEqual({ directory: fingerprint(directory), key: fingerprint(key) }, before);
  assert.throws(() => parsePrivateReceiptDescriptor(first.report, true, false), { code: 'WORKFLOW_RECEIPT_STORAGE' });
});

// Execute the COMPLETE current production script with explicit native metadata
// DOUBLES backed by real .NET ACL/SID objects. No token is changed and no real
// filesystem operation or permission write exists in this harness. The separate
// normal-owner tests exercise the unmodified native checker on the actual host.
test('complete production owner policy: captured token equivalence preserves foreign-owner, existing-directory and ACL refusals', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const source = readFileSync(resolve('apps/daemon/src/workflow-private-storage.ts'), 'utf8').replaceAll('\r\n', '\n');
  const marker = 'const SCRIPT=String.raw`', start = source.indexOf(marker) + marker.length, end = source.indexOf('\n`;', start);
  assert.ok(start >= marker.length && end > start);
  const production = source.slice(start, end) + '\n';
  let doubled = production;
  for (const [native, fixture] of [
    ['Security.Principal.WindowsIdentity', 'ArcaneOwnerFixtureIdentity'], ['IO.Directory', 'ArcaneOwnerFixtureDirectory'],
    ['IO.File', 'ArcaneOwnerFixtureFile'], ['IO.DirectoryInfo', 'ArcaneOwnerFixtureItem'], ['IO.FileInfo', 'ArcaneOwnerFixtureItem'],
  ]) { assert.ok(doubled.includes('[' + native + ']')); doubled = doubled.replaceAll('[' + native + ']', '[' + fixture + ']'); }
  // Type seams only: the complete production predicates and catch/exit are intact.
  assert.equal(doubled.replaceAll('[ArcaneOwnerFixtureIdentity]', '[Security.Principal.WindowsIdentity]')
    .replaceAll('[ArcaneOwnerFixtureDirectory]', '[IO.Directory]').replaceAll('[ArcaneOwnerFixtureFile]', '[IO.File]')
    .replace('[ArcaneOwnerFixtureItem]::new($path)', '[IO.DirectoryInfo]::new($path)')
    .replace('[ArcaneOwnerFixtureItem]::new($path)', '[IO.FileInfo]::new($path)'), production);
  const script = ownerFixture + '\ntry { & {\n' + doubled + String.raw`
} } finally {
  [Console]::Error.WriteLine('OWNER_POLICY_METADATA_DOUBLE '+$nativeJson.Serialize(@{identities=[ArcaneOwnerFixtureState]::Identities;creates=[ArcaneOwnerFixtureState]::Creates;writes=[ArcaneOwnerFixtureState]::Writes;directoryOwnerIsUser=([ArcaneOwnerFixtureState]::DirectoryAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq [ArcaneOwnerFixtureState]::User.Value);directoryProtected=[ArcaneOwnerFixtureState]::DirectoryAcl.AreAccessRulesProtected;directoryUnchanged=([ArcaneOwnerFixtureState]::DirectoryAcl.GetSecurityDescriptorSddlForm($sections) -ceq $beforeDirectory);keyUnchanged=([ArcaneOwnerFixtureState]::KeyAcl.GetSecurityDescriptorSddlForm($sections) -ceq $beforeKey)}))
}
`;
  const user = 'S-1-5-21-100-200-300-1001', foreign = 'S-1-5-21-100-200-300-1002', admin = 'S-1-5-32-544', system = 'S-1-5-18';
  const existing = { defaultOwner: admin, directoryOwner: user, keyOwner: admin, existing: true, protected: true, directoryForeign: false, keyForeign: false, nonempty: false, unsafeAncestor: false, ancestorReparse: false, keyReparse: false, keyLength: 32 };
  const fresh = { ...existing, existing: false, protected: false, directoryOwner: admin };
  const cases = [
    { name: 'fresh captured Administrators owner tightens to exact User', value: fresh, accepted: true },
    { name: 'fresh User owner with distinct captured default', value: { ...fresh, directoryOwner: user }, accepted: true },
    { name: 'fresh captured SYSTEM owner tightens to exact User', value: { ...fresh, defaultOwner: system, directoryOwner: system }, accepted: true },
    { name: 'ordinary User token owner prepares normally', value: { ...fresh, defaultOwner: user, directoryOwner: user }, accepted: true },
    { name: 'untrusted token default owner', value: { ...fresh, defaultOwner: foreign }, accepted: false, creates: 0 },
    { name: 'missing token default owner', value: { ...fresh, defaultOwner: 'null' }, accepted: false, creates: 0 },
    { name: 'foreign fresh child owner', value: { ...fresh, directoryOwner: foreign }, accepted: false },
    { name: 'arbitrary Administrators fresh owner under User default', value: { ...fresh, defaultOwner: user }, accepted: false },
    { name: 'arbitrary SYSTEM fresh owner under Administrators default', value: { ...fresh, directoryOwner: system }, accepted: false },
    { name: 'nonempty newly created child', value: { ...fresh, nonempty: true }, accepted: false },
    { name: 'existing Administrators owner even when captured default', value: { ...existing, directoryOwner: admin }, accepted: false },
    { name: 'existing SYSTEM owner even when captured default', value: { ...existing, defaultOwner: system, directoryOwner: system }, accepted: false },
    { name: 'existing unprotected User directory', value: { ...existing, protected: false }, accepted: false },
    { name: 'existing directory foreign Read allowance', value: { ...existing, directoryForeign: true }, accepted: false },
    { name: 'exact captured Administrators key owner in private User parent', value: existing, accepted: true },
    { name: 'User key owner under Administrators default', value: { ...existing, keyOwner: user }, accepted: true },
    { name: 'exact captured SYSTEM key owner in private User parent', value: { ...existing, defaultOwner: system, keyOwner: system }, accepted: true },
    { name: 'foreign key owner', value: { ...existing, keyOwner: foreign }, accepted: false },
    { name: 'arbitrary Administrators key owner under User default', value: { ...existing, defaultOwner: user }, accepted: false },
    { name: 'arbitrary SYSTEM key owner under Administrators default', value: { ...existing, keyOwner: system }, accepted: false },
    { name: 'foreign key Read allowance', value: { ...existing, keyForeign: true }, accepted: false },
    { name: 'unsafe ancestor remains refused', value: { ...fresh, unsafeAncestor: true }, accepted: false, creates: 0 },
    { name: 'reparse ancestor remains refused', value: { ...fresh, ancestorReparse: true }, accepted: false, creates: 0 },
    { name: 'reparse key remains refused', value: { ...existing, keyReparse: true }, accepted: false },
    { name: 'wrong key length remains refused', value: { ...existing, keyLength: 31 }, accepted: false },
  ];
  const windows = process.env.SystemRoot ?? 'C:\\Windows', executable = join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  for (const scenario of cases) await t.test('native metadata DOUBLE: ' + scenario.name, () => {
    const result = childProcess.spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, PSModulePath: join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        ARCANE_WORKFLOW_ACL_ROOT: 'C:\\arcane-owner-fixture', ARCANE_WORKFLOW_ACL_PREPARE: scenario.value.existing ? '0' : '1',
        ARCANE_WORKFLOW_ACL_KEY: scenario.value.existing ? '1' : '0', ARCANE_OWNER_FIXTURE_CASE: JSON.stringify(scenario.value) },
      shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 16_384, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, scenario.accepted ? 0 : 1, result.stderr);
    const line = result.stderr.split(/\r?\n/).find(row => row.startsWith('OWNER_POLICY_METADATA_DOUBLE '));
    assert.ok(line, 'The original exit/catch must still run the fixture observation finally. ' + result.stderr);
    const metadata = JSON.parse(line.slice('OWNER_POLICY_METADATA_DOUBLE '.length)) as { identities: number; creates: number; writes: number; directoryOwnerIsUser: boolean; directoryProtected: boolean; directoryUnchanged: boolean; keyUnchanged: boolean };
    assert.equal(metadata.identities, 1, 'User and default Owner must come from one captured host identity.');
    assert.equal(metadata.keyUnchanged, true, 'Key inspection is read-only for every owner and refusal.');
    assert.equal(metadata.creates, scenario.creates ?? (scenario.value.existing ? 0 : 1));
    assert.equal(metadata.writes, scenario.accepted && !scenario.value.existing ? 1 : 0);
    if (scenario.accepted) {
      assert.equal(metadata.directoryOwnerIsUser, true); assert.equal(metadata.directoryProtected, true);
      assert.deepEqual(JSON.parse(result.stdout), { version: 1, created: !scenario.value.existing, directoryPrivate: true, keyPrivate: scenario.value.existing, ancestorsSafe: true });
    } else { assert.equal(result.stdout, ''); assert.ok(result.stderr.includes('Arcane private workflow storage unavailable.')); }
    if (scenario.value.existing || !scenario.accepted) assert.equal(metadata.directoryUnchanged, true, 'Existing/refused directory ACLs are never repaired.');
  });
  // Preserve the exact historical checker independently of later performance
  // changes; it must still reproduce the original native owner refusals.
  const previous = readFileSync(resolve('tests/fixtures/workflow-private-storage-before-owner-fix.txt'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(createHash('sha256').update(previous).digest('hex'), 'f1e777b8885e769df7b0777223405105588650e8b34033cc61f0341fbee2c582');
  let previousDouble = previous;
  for (const [native, fixture] of [
    ['Security.Principal.WindowsIdentity', 'ArcaneOwnerFixtureIdentity'], ['IO.Directory', 'ArcaneOwnerFixtureDirectory'],
    ['IO.File', 'ArcaneOwnerFixtureFile'], ['IO.DirectoryInfo', 'ArcaneOwnerFixtureItem'], ['IO.FileInfo', 'ArcaneOwnerFixtureItem'],
  ]) previousDouble = previousDouble.replaceAll('[' + native + ']', '[' + fixture + ']');
  const previousScript = script.replace(doubled, previousDouble);
  for (const scenario of [cases[0]!, cases[14]!]) await t.test('previous source-pinned policy reproduces refusal: ' + scenario.name, () => {
    const result = childProcess.spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', previousScript], {
      env: { ...process.env, PSModulePath: join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        ARCANE_WORKFLOW_ACL_ROOT: 'C:\\arcane-owner-fixture', ARCANE_WORKFLOW_ACL_PREPARE: scenario.value.existing ? '0' : '1',
        ARCANE_WORKFLOW_ACL_KEY: scenario.value.existing ? '1' : '0', ARCANE_OWNER_FIXTURE_CASE: JSON.stringify(scenario.value) },
      shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 16_384, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
    assert.equal(result.stdout, ''); assert.ok(result.stderr.includes('Arcane private workflow storage unavailable.'));
    const line = result.stderr.split(/\r?\n/).find(row => row.startsWith('OWNER_POLICY_METADATA_DOUBLE ')); assert.ok(line);
    const metadata = JSON.parse(line.slice('OWNER_POLICY_METADATA_DOUBLE '.length));
    assert.equal(metadata.identities, 1); assert.equal(metadata.writes, 0); assert.equal(metadata.keyUnchanged, true);
  });
  t.diagnostic('OWNER_POLICY_SOURCE_SHA256 ' + createHash('sha256').update(production).digest('hex') + '; 25 corrected-policy scenarios plus 2 pinned prior-policy refusals; native filesystem proof remains the normal-owner suite.');
});
