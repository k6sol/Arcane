import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, link, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectDistributionPayload, validateDistributionReceipts, exportPackagedDesktop,
  DISTRIBUTION_LIMITS } from '../../scripts/export-packaged-desktop.mjs';
import { ELECTRON } from '../../scripts/check-packaged-component-ci.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const parse = bytes => JSON.parse(bytes.toString('utf8'));
async function fixture(t) {
  const boundary = await realpath(tmpdir()), owner = await realpath(await mkdtemp(join(boundary, 'arcane-distribution-')));
  t.after(async () => { assert.equal(dirname(owner), boundary); assert.ok(owner.startsWith(join(boundary, 'arcane-distribution-')));
    await rm(owner, { recursive: true, force: true }); });
  const directory = join(owner, 'bundle'); await mkdir(directory);
  // Deliberately tiny non-executable bytes. This fixture proves integrity, never native startup.
  const content = new Map([
    ['Arcane.exe', Buffer.from('synthetic-app-not-an-executable')],
    ['resources/node/node.exe', Buffer.from('synthetic-node-not-an-executable')],
    ['resources/node/LICENSE', Buffer.from('synthetic-license')],
    ['resources/product/.github/workflows/verify.yml', Buffer.from('name: synthetic-source-payload\n')],
    ['resources/product/scripts/windows-install-cli.mjs', Buffer.from('// synthetic source bytes\n')],
  ]);
  for (const [path, bytes] of content) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), bytes); }
  const manifest = { schemaVersion: 1, kind: 'arcane-windows-directory', platform: 'win32', arch: 'x64', signed: false, installer: false,
    node: { version: 'v24.19.0' }, electron: { version: ELECTRON.version },
    sourceRelease: { manifestSha256: 'c'.repeat(64), originalManifestSha256: 'd'.repeat(64) },
    files: [...content].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })),
    fileCount: content.size, totalBytes: [...content.values()].reduce((sum, bytes) => sum + bytes.length, 0) };
  async function save() { const raw = json(manifest); await writeFile(join(directory, 'windows-manifest.json'), raw); return sha(raw); }
  return { owner, directory, content, manifest, save, manifestSha256: await save() };
}
function receipts(f) {
  const identity = { gitSha: 'a'.repeat(40), runId: '123456', runAttempt: '2', nodeVersion: '24.19.0',
    packageSha256: '1'.repeat(64), lockSha256: '2'.repeat(64),
    canonicalScripts: { packageSha256: '3'.repeat(64), verifierSha256: '4'.repeat(64), driverSha256: '5'.repeat(64) } };
  const packaged = { directory: f.directory, executable: join(f.directory, 'Arcane.exe'), manifestSha256: f.manifestSha256,
    files: f.manifest.fileCount, bytes: f.manifest.totalBytes, integrityOnly: true, signed: false, installer: false,
    installedNodeRequired: false, applicationLaunchVerified: false, nodeVersion: 'v24.19.0', electronVersion: ELECTRON.version };
  const verification = { schemaVersion: 1, directory: f.directory, executable: packaged.executable, manifestSha256: f.manifestSha256,
    inferenceStarted: false, studioOperations: 0, signed: false, fullProductVerified: false, checks: { syntheticOnly: true } };
  const app = { schemaVersion: 1, kind: 'arcane-windows-executable-smoke', checks: { syntheticOnly: true },
    inferenceStarted: false, studioOperations: 0, signed: false, fullProductVerified: false };
  const raw = { 'windows-manifest.json': json(f.manifest), 'verification.json': json(verification),
    'process-outcome.json': json({ code: 0, signal: null }),
    'mcp-runtime.json': json({ shutdownVerified: true, guidanceRead: true, code: 0, signal: null, diagnosticBytes: 0, daemonRequests: 0, inferenceStarted: false, studioOperations: 0 }),
    'app-checks.json': json(app), 'workspace.png': Buffer.from('synthetic image bytes, not a native screenshot'),
    'progress.json': json({ schemaVersion: 1, kind: 'arcane-packaged-component-ci-progress', phase: 'complete', status: 'passed', gitSha: identity.gitSha }),
    'package-proof.json': json(packaged),
    'toolchain.json': json({ schemaVersion: 1, kind: 'arcane-component-ci-toolchain', gitSha: identity.gitSha,
      runId: identity.runId, runAttempt: identity.runAttempt, packageSha256: identity.packageSha256, lockSha256: identity.lockSha256,
      canonicalScripts: identity.canonicalScripts,
      node: { version: identity.nodeVersion, platform: 'win32', arch: 'x64', executableSha256: f.manifest.files[1].sha256, licenseSha256: f.manifest.files[2].sha256 },
      electron: { version: ELECTRON.version, archiveSha256: ELECTRON.archiveSha256, acquisition: 'owned-child-exited-and-archive-verified', installerExit: { terminalAcknowledged: true, code: 0, signal: null } } }),
  };
  raw['success.json'] = json({ schemaVersion: 1, kind: 'arcane-packaged-component-ci', status: 'passed', gitSha: identity.gitSha,
    lockSha256: identity.lockSha256, nodeVersion: identity.nodeVersion, electronVersion: ELECTRON.version,
    manifestSha256: f.manifestSha256, files: f.manifest.fileCount, bytes: f.manifest.totalBytes,
    artifactSha256: Object.fromEntries(['windows-manifest.json', 'verification.json', 'process-outcome.json', 'mcp-runtime.json', 'app-checks.json', 'workspace.png']
      .map(name => [name, sha(raw[name])])), executableSmokeVerified: true, ownedShutdownChecksVerified: true,
    automaticRetries: 0, signed: false, installer: false, fullProductVerified: false, inferenceStarted: false, studioOperations: 0 });
  return { raw, identity };
}
function change(raw, name, edit, updateHash = false) {
  const value = parse(raw[name]); edit(value); raw[name] = json(value);
  if (updateHash) { const success = parse(raw['success.json']); success.artifactSha256[name] = sha(raw[name]); raw['success.json'] = json(success); }
}

test('closed portable inventory preserves hidden reviewed source files without changing any payload bytes', async t => {
  const f = await fixture(t), before = await readFile(join(f.directory, 'windows-manifest.json'));
  const result = await inspectDistributionPayload(f.directory, f.manifestSha256);
  assert.equal(result.files, f.content.size); assert.equal(result.bytes, f.manifest.totalBytes);
  assert.equal(result.sourceReleaseSha256, f.manifest.sourceRelease.manifestSha256);
  assert.ok(result.manifest.files.some(file => file.path === 'resources/product/.github/workflows/verify.yml'));
  for (const [path, bytes] of f.content) assert.deepEqual(await readFile(join(f.directory, path)), bytes);
  assert.deepEqual(await readFile(join(f.directory, 'windows-manifest.json')), before);
});

test('receipt correlation admits only the exact original successful same-run metadata, without claiming a native test', async t => {
  const f = await fixture(t), { raw, identity } = receipts(f), result = validateDistributionReceipts(raw, identity);
  assert.equal(result.success.manifestSha256, f.manifestSha256); assert.equal(result.toolchain.runAttempt, '2');
  assert.deepEqual(result.verification.checks, { syntheticOnly: true }, 'The production entry must separately require the real full smoke-check inventory.');
});

test('stale commits, other runs, attempts and changed source toolchains cannot be relabelled as this distribution', async t => {
  const f = await fixture(t);
  for (const [name, key, value] of [
    ['success.json', 'gitSha', 'b'.repeat(40)], ['success.json', 'status', 'failed'],
    ['success.json', 'ownedShutdownChecksVerified', false], ['success.json', 'automaticRetries', 1],
    ['success.json', 'fullProductVerified', true], ['success.json', 'signed', true],
    ['progress.json', 'phase', 'verify'], ['progress.json', 'status', 'running'],
    ['toolchain.json', 'runId', '123457'], ['toolchain.json', 'runAttempt', '1'],
    ['toolchain.json', 'packageSha256', 'f'.repeat(64)], ['toolchain.json', 'lockSha256', 'f'.repeat(64)],
  ]) {
    const { raw, identity } = receipts(f); change(raw, name, row => { row[key] = value; });
    assert.throws(() => validateDistributionReceipts(raw, identity), /DISTRIBUTION_/, name + ':' + key);
  }
  for (const key of ['packageSha256', 'verifierSha256', 'driverSha256']) {
    const { raw, identity } = receipts(f); change(raw, 'toolchain.json', row => { row.canonicalScripts[key] = 'f'.repeat(64); });
    assert.throws(() => validateDistributionReceipts(raw, identity), /DISTRIBUTION_TOOLCHAIN/);
  }
});

test('every actual smoke artifact is hash-bound and matching hashes cannot excuse failed shutdown', async t => {
  const f = await fixture(t);
  for (const name of ['windows-manifest.json', 'verification.json', 'process-outcome.json', 'mcp-runtime.json', 'app-checks.json', 'workspace.png']) {
    const { raw, identity } = receipts(f); raw[name] = Buffer.concat([raw[name], Buffer.from(' ')]);
    assert.throws(() => validateDistributionReceipts(raw, identity), /DISTRIBUTION_/, name);
  }
  for (const [name, key, value] of [['process-outcome.json', 'code', 1], ['mcp-runtime.json', 'shutdownVerified', false],
    ['mcp-runtime.json', 'daemonRequests', 1], ['app-checks.json', 'inferenceStarted', true]]) {
    const { raw, identity } = receipts(f); change(raw, name, row => { row[key] = value; }, true);
    assert.throws(() => validateDistributionReceipts(raw, identity), /DISTRIBUTION_SMOKE/);
  }
});

test('missing, extra, malformed and oversized receipts refuse before export admission', async t => {
  const f = await fixture(t);
  for (const edit of [raw => { delete raw['success.json']; }, raw => { raw['failure.json'] = json({ status: 'failed' }); },
    raw => { raw['success.json'] = Buffer.from('{'); }, raw => { raw['success.json'] = Buffer.alloc(DISTRIBUTION_LIMITS.receiptBytes + 1); }]) {
    const { raw, identity } = receipts(f); edit(raw); assert.throws(() => validateDistributionReceipts(raw, identity));
  }
});

test('post-smoke payload or manifest changes and missing hidden payload are refused', async t => {
  for (const kind of ['payload', 'manifest', 'missing-hidden']) await t.test(kind, async sub => {
    const f = await fixture(sub);
    if (kind === 'payload') await writeFile(join(f.directory, 'Arcane.exe'), Buffer.alloc(f.content.get('Arcane.exe').length, 88));
    if (kind === 'manifest') await writeFile(join(f.directory, 'windows-manifest.json'), json({ ...f.manifest, totalBytes: 0 }));
    if (kind === 'missing-hidden') await rm(join(f.directory, 'resources/product/.github/workflows/verify.yml'));
    await assert.rejects(inspectDistributionPayload(f.directory, f.manifestSha256), /DISTRIBUTION_/);
  });
});

test('post-smoke profiles, credentials, workspace state and unrelated empty directories never join the archive', async t => {
  for (const path of ['auth.json', '.env', 'profile/token', 'runtime/project.json', 'extra-workspace.json', 'unlisted-empty'])
    await t.test(path, async sub => {
      const f = await fixture(sub), target = join(f.directory, path);
      if (path === 'unlisted-empty') await mkdir(target);
      else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, 'private fixture state'); }
      await assert.rejects(inspectDistributionPayload(f.directory, f.manifestSha256), /DISTRIBUTION_(?:PRIVATE_PATH|EXTRA)/);
    });
});

test('even a manifest-declared private profile or credential path remains excluded', async t => {
  for (const path of ['resources/product/profile/data', 'resources/product/.env.local', 'resources/product/auth.json', 'resources/product/runtime/workspace.json', 'resources/product/docs/vault/README.md'])
    await t.test(path, async sub => {
      const f = await fixture(sub), raw = Buffer.from('private fixture');
      f.manifest.files.push({ path, bytes: raw.length, sha256: sha(raw) }); f.manifest.fileCount++; f.manifest.totalBytes += raw.length;
      await assert.rejects(inspectDistributionPayload(f.directory, await f.save()), /DISTRIBUTION_PRIVATE_PATH/);
    });
});

test('hardlinked payload and redirected payload ancestry are refused without reading foreign state', async t => {
  for (const kind of ['hardlink', 'directory-link']) await t.test(kind, async sub => {
    const f = await fixture(sub);
    if (kind === 'hardlink') await link(join(f.directory, 'Arcane.exe'), join(f.owner, 'other-link'));
    else {
      const original = join(f.directory, 'resources/product/.github'), moved = join(f.owner, 'foreign');
      await mkdir(moved); await rm(original, { recursive: true });
      await symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
    }
    await assert.rejects(inspectDistributionPayload(f.directory, f.manifestSha256), /DISTRIBUTION_LINK_OR_TYPE/);
  });
});

test('inventory path, count and byte limits are enforced before hashing synthetic oversized descriptors', async t => {
  for (const edit of [
    manifest => { manifest.files[0].path = '../escape'; },
    manifest => { manifest.files[0].path = 'resources/product/docs/vault/Operations/Current State.md'; },
    manifest => { manifest.files[0].path = 'a'.repeat(1025); },
    manifest => { manifest.files[0].path = Array(33).fill('a').join('/'); },
    manifest => { manifest.files[0].path = 'CON.txt'; },
    manifest => { manifest.files[0].bytes = DISTRIBUTION_LIMITS.fileBytes + 1; },
    manifest => { manifest.files.push({ ...manifest.files[0], path: 'ARCANE.exe' }); manifest.fileCount++; },
    manifest => { manifest.files = Array.from({ length: DISTRIBUTION_LIMITS.files + 1 }, (_, i) => ({ path: 'f' + i, bytes: 0, sha256: sha('') })); manifest.fileCount = manifest.files.length; },
    manifest => { manifest.files = Array.from({ length: 5 }, (_, i) => ({ path: 'f' + i, bytes: DISTRIBUTION_LIMITS.fileBytes, sha256: sha('') })); manifest.fileCount = 5; manifest.totalBytes = 5 * DISTRIBUTION_LIMITS.fileBytes; },
  ]) {
    const f = await fixture(t); edit(f.manifest); await assert.rejects(inspectDistributionPayload(f.directory, await f.save()), /DISTRIBUTION_/);
  }
});

test('the actual exporter refuses caller options before any hosted, filesystem or native operation', async () => {
  await assert.rejects(exportPackagedDesktop({ directory: resolve('not-an-export-input') }), /DISTRIBUTION_INVOCATION/);
});
