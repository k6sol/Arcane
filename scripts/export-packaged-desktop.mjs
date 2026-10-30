/** Export the existing hosted component bundle; never package, launch or install it. */
import { createHash } from 'node:crypto';
import { lstat, realpath, open, readdir, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHostedEnvironment, assertSourceIdentity, acquisitionEnvironment, ELECTRON } from './check-packaged-component-ci.mjs';

const REPOSITORY = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MANIFEST = 'windows-manifest.json';
const SIDECAR = 'ci-desktop-distribution/distribution.json';
const RECEIPTS = Object.freeze(['progress.json', 'success.json', 'toolchain.json', 'package-proof.json',
  'windows-manifest.json', 'verification.json', 'process-outcome.json', 'mcp-runtime.json', 'app-checks.json', 'workspace.png']);
export const DISTRIBUTION_LIMITS = Object.freeze({ files: 32768, fileBytes: 512 * 1024 ** 2,
  bytes: 2 * 1024 ** 3, manifestBytes: 8 * 1024 ** 2, receiptBytes: 128 * 1024,
  evidenceBytes: 32 * 1024 ** 2, sidecarBytes: 16 * 1024, pathLength: 1024, depth: 32 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const demand = (condition, code) => { if (!condition) throw new Error(code); };
const stable = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'].every(key => a[key] === b[key]);
const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const PRIVATE = new Set(['.git', '.codex', '.claude', '.agents', '.ssh', '.arcane', 'profile', 'profiles', 'user-data', 'userdata']);
const SECRET = /^(?:\.env(?:\..*)?|\.npmrc|auth\.json|credentials\.json|daemon\.json|preferences\.json|.*\.(?:log|key|pem|partial))$/i;

function safeRelative(value) {
  demand(typeof value === 'string' && value.length > 0 && value.length <= DISTRIBUTION_LIMITS.pathLength &&
    /^[A-Za-z0-9_@.+\-/]+$/.test(value), 'DISTRIBUTION_PATH');
  demand(value !== 'resources/product/docs/vault' && !value.startsWith('resources/product/docs/vault/'), 'DISTRIBUTION_PRIVATE_PATH');
  const parts = value.split('/'), dependency = value.startsWith('resources/product/node_modules/');
  demand(parts.length <= DISTRIBUTION_LIMITS.depth && parts.every(part => part && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
    !PRIVATE.has(part.toLowerCase()) && !SECRET.test(part) &&
    (!['runtime', '.runtime', 'cache', '__pycache__', 'generated'].includes(part.toLowerCase()) ||
      dependency && ['runtime', 'cache', 'generated'].includes(part.toLowerCase()))), 'DISTRIBUTION_PRIVATE_PATH');
  return value;
}

async function direct(path, directory = false) {
  const stat = await lstat(path, { bigint: true });
  demand(!stat.isSymbolicLink() && samePath(path, await realpath(path)) &&
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n), 'DISTRIBUTION_LINK_OR_TYPE');
  return stat;
}
async function bounded(path, maximum) {
  const before = await direct(path);
  demand(before.size >= 0n && before.size <= BigInt(maximum), 'DISTRIBUTION_SIZE');
  const handle = await open(path, 'r');
  try {
    demand(stable(before, await handle.stat({ bigint: true })), 'DISTRIBUTION_CHANGED');
    const bytes = Buffer.alloc(Number(before.size) + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break; offset += bytesRead;
    }
    demand(offset === Number(before.size) && stable(before, await handle.stat({ bigint: true })) &&
      stable(before, await direct(path)), 'DISTRIBUTION_CHANGED');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
async function fileDigest(path, expected) {
  const before = await direct(path);
  demand(before.size === BigInt(expected) && expected <= DISTRIBUTION_LIMITS.fileBytes, 'DISTRIBUTION_SIZE');
  const handle = await open(path, 'r');
  try {
    demand(stable(before, await handle.stat({ bigint: true })), 'DISTRIBUTION_CHANGED');
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let count = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected - count + 1), null);
      if (!bytesRead) break;
      count += bytesRead; demand(count <= expected, 'DISTRIBUTION_CHANGED'); digest.update(buffer.subarray(0, bytesRead));
    }
    demand(count === expected && stable(before, await handle.stat({ bigint: true })) &&
      stable(before, await direct(path)), 'DISTRIBUTION_CHANGED');
    return digest.digest('hex');
  } finally { await handle.close(); }
}

/** Data/integrity inspection only. Small fixture inventories do not prove native startup. */
export async function inspectDistributionPayload(directory, expectedManifestSha256) {
  demand(hash(expectedManifestSha256), 'DISTRIBUTION_MANIFEST');
  directory = resolve(directory); const root = await direct(directory, true);
  const raw = await bounded(join(directory, MANIFEST), DISTRIBUTION_LIMITS.manifestBytes);
  demand(sha(raw) === expectedManifestSha256, 'DISTRIBUTION_MANIFEST');
  const manifest = decode(raw);
  demand(manifest?.schemaVersion === 1 && manifest.kind === 'arcane-windows-directory' && manifest.platform === 'win32' &&
    manifest.arch === 'x64' && manifest.signed === false && manifest.installer === false &&
    Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= DISTRIBUTION_LIMITS.files &&
    manifest.fileCount === manifest.files.length, 'DISTRIBUTION_MANIFEST');
  const files = new Map(), directories = new Set(['']); let total = 0;
  for (const entry of manifest.files) {
    demand(object(entry) && Object.keys(entry).sort().join(',') === 'bytes,path,sha256', 'DISTRIBUTION_MANIFEST');
    const path = safeRelative(entry.path), folded = path.toLowerCase();
    demand(folded !== MANIFEST && !files.has(folded) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 &&
      entry.bytes <= DISTRIBUTION_LIMITS.fileBytes && hash(entry.sha256), 'DISTRIBUTION_MANIFEST');
    total += entry.bytes; demand(total <= DISTRIBUTION_LIMITS.bytes, 'DISTRIBUTION_SIZE'); files.set(folded, entry);
    const parts = path.split('/'); parts.pop();
    while (parts.length) { directories.add(parts.join('/').toLowerCase()); parts.pop(); }
  }
  demand(Number.isSafeInteger(manifest.totalBytes) && total === manifest.totalBytes && files.has('arcane.exe') &&
    files.has('resources/node/node.exe'), 'DISTRIBUTION_MANIFEST');
  const found = new Set(); let foundDirectories = 0;
  async function walk(path, prefix = '') {
    const before = await direct(path, true); const names = await readdir(path);
    demand(names.length <= DISTRIBUTION_LIMITS.files + 1 && ++foundDirectories <= directories.size, 'DISTRIBUTION_INVENTORY');
    for (const name of names) {
      const child = prefix ? prefix + '/' + name : name, full = join(path, name), folded = child.toLowerCase();
      safeRelative(child); const stat = await lstat(full, { bigint: true });
      demand(!stat.isSymbolicLink(), 'DISTRIBUTION_LINK_OR_TYPE');
      if (stat.isDirectory()) {
        demand(directories.has(folded), 'DISTRIBUTION_EXTRA'); await walk(full, child);
      } else {
        demand(!found.has(folded), 'DISTRIBUTION_INVENTORY'); found.add(folded);
        if (child === MANIFEST) demand(sha(await bounded(full, DISTRIBUTION_LIMITS.manifestBytes)) === expectedManifestSha256, 'DISTRIBUTION_CHANGED');
        else {
          const entry = files.get(folded); demand(entry && entry.path === child, 'DISTRIBUTION_EXTRA');
          demand(await fileDigest(full, entry.bytes) === entry.sha256, 'DISTRIBUTION_CHECKSUM');
        }
      }
    }
    demand(stable(before, await direct(path, true)), 'DISTRIBUTION_CHANGED');
  }
  await walk(directory);
  demand(found.size === files.size + 1 && [...files.keys()].every(path => found.has(path)) &&
    stable(root, await direct(directory, true)), 'DISTRIBUTION_INVENTORY');
  return Object.freeze({ manifestSha256: expectedManifestSha256, files: files.size, bytes: total,
    sourceReleaseSha256: manifest.sourceRelease?.manifestSha256, originalSourceReleaseSha256: manifest.sourceRelease?.originalManifestSha256,
    nodeVersion: manifest.node?.version, electronVersion: manifest.electron?.version,
    nodeSha256: files.get('resources/node/node.exe').sha256, manifest });
}

/** Strict same-run receipt correlation; it grants no execution/install authority. */
export function validateDistributionReceipts(raw, identity) {
  demand(object(raw) && RECEIPTS.every(name => Buffer.isBuffer(raw[name])) && Object.keys(raw).length === RECEIPTS.length,
    'DISTRIBUTION_RECEIPTS');
  demand(object(identity) && /^[a-f0-9]{40}$/.test(identity.gitSha ?? '') && /^[1-9]\d{0,19}$/.test(identity.runId ?? '') &&
    /^[1-9]\d{0,5}$/.test(identity.runAttempt ?? '') && /^24\.\d+\.\d+$/.test(identity.nodeVersion ?? ''), 'DISTRIBUTION_IDENTITY');
  let total = 0;
  for (const name of RECEIPTS) {
    const limit = name === MANIFEST ? DISTRIBUTION_LIMITS.manifestBytes : name === 'workspace.png' ? 8 * 1024 ** 2 : DISTRIBUTION_LIMITS.receiptBytes;
    total += raw[name].length; demand(raw[name].length > 0 && raw[name].length <= limit && total <= DISTRIBUTION_LIMITS.evidenceBytes, 'DISTRIBUTION_SIZE');
  }
  const success = decode(raw['success.json']), toolchain = decode(raw['toolchain.json']), packaged = decode(raw['package-proof.json']);
  const progress = decode(raw['progress.json']), verification = decode(raw['verification.json']), manifest = decode(raw[MANIFEST]);
  const outcome = decode(raw['process-outcome.json']), mcp = decode(raw['mcp-runtime.json']), app = decode(raw['app-checks.json']);
  demand(success?.schemaVersion === 1 && success.kind === 'arcane-packaged-component-ci' && success.status === 'passed' &&
    success.gitSha === identity.gitSha && success.nodeVersion === identity.nodeVersion && success.electronVersion === ELECTRON.version &&
    success.executableSmokeVerified === true && success.ownedShutdownChecksVerified === true && success.automaticRetries === 0 &&
    success.signed === false && success.installer === false && success.fullProductVerified === false &&
    success.inferenceStarted === false && success.studioOperations === 0 && hash(success.manifestSha256), 'DISTRIBUTION_SUCCESS');
  demand(progress?.schemaVersion === 1 && progress.kind === 'arcane-packaged-component-ci-progress' && progress.phase === 'complete' &&
    progress.status === 'passed' && progress.gitSha === identity.gitSha, 'DISTRIBUTION_SUCCESS');
  demand(toolchain?.schemaVersion === 1 && toolchain.kind === 'arcane-component-ci-toolchain' && toolchain.gitSha === identity.gitSha &&
    toolchain.runId === identity.runId && toolchain.runAttempt === identity.runAttempt && toolchain.node?.version === identity.nodeVersion &&
    toolchain.node.platform === 'win32' && toolchain.node.arch === 'x64' && hash(toolchain.node.executableSha256) &&
    hash(toolchain.node.licenseSha256) && toolchain.electron?.version === ELECTRON.version &&
    toolchain.electron.archiveSha256 === ELECTRON.archiveSha256 && toolchain.electron.acquisition === 'owned-child-exited-and-archive-verified' &&
    toolchain.electron.installerExit?.terminalAcknowledged === true && toolchain.electron.installerExit.code === 0 &&
    toolchain.electron.installerExit.signal === null &&
    toolchain.packageSha256 === identity.packageSha256 && toolchain.lockSha256 === identity.lockSha256 &&
    success.lockSha256 === identity.lockSha256 && object(toolchain.canonicalScripts) &&
    ['packageSha256', 'verifierSha256', 'driverSha256'].every(key => hash(identity.canonicalScripts?.[key]) &&
      toolchain.canonicalScripts[key] === identity.canonicalScripts[key]), 'DISTRIBUTION_TOOLCHAIN');
  demand(packaged?.manifestSha256 === success.manifestSha256 && packaged.files === success.files && packaged.bytes === success.bytes &&
    packaged.integrityOnly === true && packaged.signed === false && packaged.installer === false && packaged.installedNodeRequired === false &&
    packaged.applicationLaunchVerified === false && packaged.nodeVersion === 'v' + identity.nodeVersion &&
    packaged.electronVersion === ELECTRON.version && typeof packaged.directory === 'string' && typeof packaged.executable === 'string' &&
    sha(raw[MANIFEST]) === success.manifestSha256 && manifest?.fileCount === success.files && manifest.totalBytes === success.bytes,
    'DISTRIBUTION_PACKAGE');
  demand(object(success.artifactSha256) && Object.keys(success.artifactSha256).sort().join(',') ===
    ['windows-manifest.json', 'verification.json', 'process-outcome.json', 'mcp-runtime.json', 'app-checks.json', 'workspace.png'].sort().join(',') &&
    Object.entries(success.artifactSha256).every(([name, digest]) => hash(digest) && sha(raw[name]) === digest), 'DISTRIBUTION_EVIDENCE');
  demand(verification?.schemaVersion === 1 && samePath(verification.directory, packaged.directory) &&
    samePath(verification.executable, packaged.executable) && verification.manifestSha256 === success.manifestSha256 &&
    verification.inferenceStarted === false && verification.studioOperations === 0 && verification.signed === false &&
    verification.fullProductVerified === false && outcome?.code === 0 && outcome.signal === null && mcp?.shutdownVerified === true &&
    mcp.guidanceRead === true && mcp.code === 0 && mcp.signal === null && mcp.diagnosticBytes === 0 && mcp.daemonRequests === 0 && mcp.inferenceStarted === false &&
    mcp.studioOperations === 0 && app?.schemaVersion === 1 && app.kind === 'arcane-windows-executable-smoke' &&
    app.inferenceStarted === false && app.studioOperations === 0 && app.signed === false && app.fullProductVerified === false,
    'DISTRIBUTION_SMOKE');
  return { success, toolchain, packaged, verification, app, manifest };
}

async function exclusive(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function exportPackagedDesktop() {
  demand(arguments.length === 0 && process.release.name === 'node' && process.execArgv.length === 0, 'DISTRIBUTION_INVOCATION');
  assertHostedEnvironment({ platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
    electronVersion: process.versions.electron, env: process.env });
  demand(samePath(REPOSITORY, process.env.GITHUB_WORKSPACE), 'DISTRIBUTION_WORKSPACE'); await direct(REPOSITORY, true);
  const runtime = join(REPOSITORY, 'runtime'); await direct(runtime, true);
  const artifacts = join(runtime, 'ci-desktop-smoke-artifacts'); await direct(artifacts, true);
  const output = process.env.GITHUB_OUTPUT;
  demand(typeof output === 'string' && output.length <= 4096 && resolve(output) === output, 'DISTRIBUTION_OUTPUT');
  await direct(output);
  const { runBoundedChild, smokeChecksComplete } = await import('./check-windows-executable.mjs');
  const { verifyWindowsBundle } = await import('./package-windows.mjs');
  const childEnv = acquisitionEnvironment(process.env, join(runtime, 'ci-desktop-distribution'));
  async function source() {
    const options = { cwd: REPOSITORY, env: childEnv, deadlineMs: 10000, maxOutputBytes: 1024 };
    const head = await runBoundedChild('git', ['rev-parse', '--verify', 'HEAD'], options);
    demand(head.code === 0 && head.signal === null, 'DISTRIBUTION_SOURCE'); assertSourceIdentity(head.output.trim(), process.env.GITHUB_SHA);
    const clean = await runBoundedChild('git', ['diff', '--no-ext-diff', '--quiet', 'HEAD', '--', '.'], options);
    demand(clean.code === 0 && clean.signal === null && clean.outputBytes === 0, 'DISTRIBUTION_SOURCE');
  }
  await source();
  const raw = {};
  for (const name of RECEIPTS) raw[name] = await bounded(join(artifacts, name), name === MANIFEST ? DISTRIBUTION_LIMITS.manifestBytes :
    name === 'workspace.png' ? 8 * 1024 ** 2 : DISTRIBUTION_LIMITS.receiptBytes);
  // A failed/partial driver may leave success-shaped files; only the fixed completed same-run set is admitted.
  try { await lstat(join(artifacts, 'failure.json')); throw new Error('DISTRIBUTION_DRIVER_FAILED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const identity = { gitSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    nodeVersion: process.versions.node, packageSha256: sha(await bounded(join(REPOSITORY, 'package.json'), 1024 ** 2)),
    lockSha256: sha(await bounded(join(REPOSITORY, 'package-lock.json'), 4 * 1024 ** 2)), canonicalScripts: {} };
  for (const [key, path] of Object.entries({ packageSha256: 'scripts/package-windows.mjs',
    verifierSha256: 'scripts/check-windows-executable.mjs', driverSha256: 'scripts/check-packaged-component-ci.mjs' }))
    identity.canonicalScripts[key] = sha(await bounded(join(REPOSITORY, path), 1024 ** 2));
  const { success, toolchain, packaged, verification, app } = validateDistributionReceipts(raw, identity);
  demand(smokeChecksComplete(verification.checks) && smokeChecksComplete(app.checks) &&
    ['runtimeImportsVerified', 'parentLossShutdownVerified', 'mcpProtocolVerified', 'bundledGuidanceVerified', 'mcpShutdownVerified']
      .every(key => verification.checks[key] === true), 'DISTRIBUTION_SMOKE');
  const bundle = resolve(packaged.directory), bundleRelativePath = relative(runtime, bundle).split('\\').join('/');
  demand(/^windows\/arcane-win32-x64-[A-Za-z0-9_-]{6}$/.test(bundleRelativePath) &&
    samePath(dirname(bundle), join(runtime, 'windows')) && samePath(packaged.executable, join(bundle, 'Arcane.exe')), 'DISTRIBUTION_BUNDLE_PATH');
  await direct(join(runtime, 'windows'), true);
  const proof = await verifyWindowsBundle(bundle); // Integrity only; no second packaging or native launch.
  demand(proof.manifestSha256 === success.manifestSha256 && proof.files === success.files && proof.bytes === success.bytes,
    'DISTRIBUTION_PACKAGE');
  const inspected = await inspectDistributionPayload(bundle, success.manifestSha256);
  demand(inspected.files === success.files && inspected.bytes === success.bytes && hash(inspected.sourceReleaseSha256) &&
    hash(inspected.originalSourceReleaseSha256) && inspected.nodeVersion === 'v' + identity.nodeVersion &&
    inspected.electronVersion === ELECTRON.version && inspected.nodeSha256 === toolchain.node.executableSha256 &&
    inspected.manifest.files.find(file => file.path === 'resources/node/LICENSE')?.sha256 === toolchain.node.licenseSha256,
    'DISTRIBUTION_PACKAGE');
  await source();
  for (const name of RECEIPTS) demand(sha(await bounded(join(artifacts, name), raw[name].length)) === sha(raw[name]), 'DISTRIBUTION_CHANGED');
  const sidecar = { schemaVersion: 1, kind: 'arcane-windows-portable-distribution', repository: 'k6sol/Arcane',
    gitSha: identity.gitSha, runId: identity.runId, runAttempt: identity.runAttempt, bundleRelativePath,
    manifestSha256: success.manifestSha256, sourceReleaseSha256: inspected.sourceReleaseSha256,
    originalSourceReleaseSha256: inspected.originalSourceReleaseSha256, lockSha256: identity.lockSha256,
    files: inspected.files, bytes: inspected.bytes, nodeVersion: identity.nodeVersion, electronVersion: ELECTRON.version,
    evidenceSha256: Object.fromEntries(RECEIPTS.map(name => [name, sha(raw[name])])),
    executableSmokeVerified: true, ownedShutdownChecksVerified: true, automaticRetries: 0,
    signed: false, installer: false, installationVerified: false, fullProductVerified: false, inferenceStarted: false, studioOperations: 0 };
  const sidecarRaw = Buffer.from(JSON.stringify(sidecar, null, 2) + '\n');
  demand(sidecarRaw.length <= DISTRIBUTION_LIMITS.sidecarBytes, 'DISTRIBUTION_SIZE');
  const container = join(runtime, 'ci-desktop-distribution'); await mkdir(container); await direct(container, true);
  const sidecarPath = join(runtime, SIDECAR); await exclusive(sidecarPath, sidecarRaw);
  demand(sha(await bounded(sidecarPath, DISTRIBUTION_LIMITS.sidecarBytes)) === sha(sidecarRaw), 'DISTRIBUTION_CHANGED');
  // upload-artifact's least common ancestor is runtime. These two paths preserve
  // windows/<actual bundle>/... and ci-desktop-distribution/distribution.json.
  const outputHandle = await open(output, 'a');
  try {
    const before = await direct(output); demand(stable(before, await outputHandle.stat({ bigint: true })), 'DISTRIBUTION_OUTPUT');
    await outputHandle.writeFile('bundle=runtime/' + bundleRelativePath + '\nsidecar=runtime/' + SIDECAR + '\n');
    await outputHandle.sync();
    const after = await outputHandle.stat({ bigint: true }), named = await direct(output);
    demand(['dev', 'ino', 'mode', 'nlink'].every(key => before[key] === after[key]) && stable(after, named), 'DISTRIBUTION_OUTPUT');
  } finally { await outputHandle.close(); }
  return Object.freeze({ gitSha: identity.gitSha, runId: identity.runId, runAttempt: identity.runAttempt,
    manifestSha256: success.manifestSha256, files: inspected.files, bytes: inspected.bytes });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { process.stderr.write('Usage: node scripts/export-packaged-desktop.mjs\n'); process.exitCode = 1; }
  else exportPackagedDesktop().then(result => process.stdout.write(JSON.stringify(result) + '\n'), () => {
    process.stderr.write('Portable distribution export refused. The original component evidence is retained; no rebuild, launch or retry was attempted.\n');
    process.exitCode = 1;
  });
}
