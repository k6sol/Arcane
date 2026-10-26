/** Hosted Windows component observation only. This does not replace release:desktop. */
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, writeFile, readdir, mkdir, mkdtemp, rename, open } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MiB = 1024 * 1024;
export const ELECTRON = Object.freeze({
  version: '44.9.1', archive: 'electron-v44.9.1-win32-x64.zip',
  archiveSha256: '41bd7900bd42d0f49110a81617876137041fbbf473466920248ddb076349ef91',
  installerSha256: '3b9e0c3c9070edbdb732dc05ed23c6f1c6b7a404bd623033a2f0b71052534e93',
  checksumsSha256: '33a99288d18e64500fcecf3769520f89a68cdf63fdba63d09087d859718dd834',
  integrity: 'sha512-x/tECFFDa2OFNjMObFH0EGKWrCnFZPOR1wP2iMIVt0STecGl8FmDXdaiaryY0kf8mtw9kSLP2yK8dfdaWkfDmw==',
});
export const ARTIFACT_FILES = Object.freeze([
  'progress.json', 'success.json', 'failure.json', 'toolchain.json', 'package-proof.json',
  'windows-manifest.json', 'verification.json', 'process-outcome.json', 'mcp-runtime.json',
  'app-checks.json', 'workspace.png', 'app-error.json',
]);
const BOUNDARIES = Object.freeze({ automaticRetries: 0, signed: false, installer: false,
  fullProductVerified: false, inferenceStarted: false, studioOperations: 0 });
const FAILURE_CODES = new Set([
  'SOURCE_HEAD_UNAVAILABLE', 'SOURCE_SHA_MISMATCH', 'TRACKED_SOURCE_NOT_CLEAN', 'ELECTRON_METADATA_MISMATCH',
  'ELECTRON_CHECKSUM_MISMATCH', 'FRESH_OUTPUT_REQUIRED', 'ACTUAL_NODE_REQUIRED', 'ADJACENT_NODE_LICENSE_UNAVAILABLE',
  'COMPLETE_NODE_LICENSE_REQUIRED', 'ELECTRON_INSTALL_DID_NOT_SUCCEED', 'DOWNLOADED_ARCHIVE_HASH_MISMATCH',
  'ELECTRON_INSTALL_OUTPUT_MISMATCH', 'TOOLCHAIN_METADATA_CHANGED', 'CACHE_INVENTORY_INVALID', 'CACHE_INVENTORY_BOUND',
  'UNEXPECTED_ELECTRON_ARCHIVE', 'CACHE_ARCHIVE_NOT_UNIQUE', 'PACKAGE_RETURN_MISMATCH', 'VERIFIER_REPORT_NOT_FRESH',
  'VERIFIER_RECEIPT_MISMATCH', 'NATIVE_COMPONENT_PROOF_INCOMPLETE', 'FINAL_MANIFEST_CHANGED',
  'FINAL_TOOLCHAIN_METADATA_CHANGED', 'FINAL_SOURCE_HEAD_UNAVAILABLE', 'REQUIRED_ARTIFACT_MISSING',
  'REDIRECTED_OR_NONREGULAR_INPUT', 'INPUT_SIZE_BOUND', 'INPUT_CHANGED', 'SCREENSHOT_INVALID',
  'ARTIFACT_TOTAL_BOUND', 'ARTIFACT_JSON_INVALID', 'UNOWNED_COMPONENT_OUTPUT', 'AMBIGUOUS_VERIFICATION_OUTPUT',
  'COPIED_EVIDENCE_CHANGED',
]);
const sha = value => createHash('sha256').update(value).digest('hex');
const requireThat = (condition, code) => { if (!condition) throw new Error(code); };
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Pure preflight helpers are exported for refusal/metadata tests, never native-proof injection.
export function packagedNodeVersionMatches(version, runtimeVersion) {
  return typeof runtimeVersion === 'string' && /^24\.\d+\.\d+$/.test(runtimeVersion) && version === 'v' + runtimeVersion;
}

export function assertHostedEnvironment({ platform, arch, nodeVersion, electronVersion, env }) {
  requireThat(platform === 'win32' && arch === 'x64' && /^24\.\d+\.\d+$/.test(nodeVersion) && !electronVersion, 'HOST_TOOLCHAIN_REQUIRED');
  requireThat(env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    env.RUNNER_OS === 'Windows' && env.RUNNER_ARCH === 'X64' && /^k6sol\/arcane$/i.test(env.GITHUB_REPOSITORY ?? '') &&
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && /^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? '') &&
    /^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '') && typeof env.GITHUB_WORKSPACE === 'string' &&
    win32.isAbsolute(env.GITHUB_WORKSPACE), 'HOSTED_ACTIONS_REQUIRED');
  for (const [key, value] of Object.entries(env)) {
    requireThat(!/^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_CONF)$/i.test(key) || !value, 'NODE_ENVIRONMENT_OVERRIDE_REFUSED');
    requireThat(!/^NODE_TLS_REJECT_UNAUTHORIZED$/i.test(key) || value === '1', 'TLS_OVERRIDE_REFUSED');
  }
}

export function assertSourceIdentity(head, expected) {
  requireThat(typeof head === 'string' && /^[a-f0-9]{40}$/.test(head) && head === expected, 'SOURCE_SHA_MISMATCH');
}

export function acquisitionEnvironment(source, cache) {
  const approved = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'userprofile',
    'localappdata', 'appdata', 'homedrive', 'homepath', 'number_of_processors', 'processor_architecture']);
  const result = {}, seen = new Map();
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (!approved.has(lower)) continue;
    requireThat(typeof value === 'string' && (!seen.has(lower) || seen.get(lower) === value), 'AMBIGUOUS_CHILD_ENVIRONMENT');
    if (!seen.has(lower)) result[key] = value;
    seen.set(lower, value);
  }
  // install.js passes this exact key as cacheRoot. No mirrors, platform overrides,
  // remote-checksum mode, proxies, npm config, credentials or Node injection survive.
  result.electron_config_cache = cache;
  result.CI = 'true';
  return result;
}

export function validateElectronMetadata({ pkg, lock, installed, installerSha256, checksumsSha256, checksums }) {
  const entry = lock?.packages?.['node_modules/electron'];
  requireThat(pkg?.name === 'arcane' && pkg.devDependencies?.electron === ELECTRON.version &&
    lock?.packages?.['']?.devDependencies?.electron === ELECTRON.version && entry?.version === ELECTRON.version &&
    entry.resolved === 'https://registry.npmjs.org/electron/-/electron-44.9.1.tgz' && entry.integrity === ELECTRON.integrity &&
    installed?.name === 'electron' && installed.version === ELECTRON.version && installed.bin?.['install-electron'] === 'install.js', 'ELECTRON_METADATA_MISMATCH');
  requireThat(installerSha256 === ELECTRON.installerSha256 && checksumsSha256 === ELECTRON.checksumsSha256 &&
    object(checksums) && Object.hasOwn(checksums, ELECTRON.archive) && checksums[ELECTRON.archive] === ELECTRON.archiveSha256, 'ELECTRON_CHECKSUM_MISMATCH');
}

export function selectElectronArchive(entries) {
  requireThat(Array.isArray(entries) && entries.length > 0 && entries.length <= 32, 'CACHE_INVENTORY_INVALID');
  let total = 0;
  for (const entry of entries) {
    requireThat(object(entry) && typeof entry.path === 'string' && entry.path.length <= 1024 &&
      /^[a-zA-Z0-9._/-]+$/.test(entry.path) && !entry.path.split('/').some(part => !part || part === '.' || part === '..') &&
      Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 512 * MiB, 'CACHE_INVENTORY_INVALID');
    total += entry.bytes;
    requireThat(!/\.zip$/i.test(entry.path) || entry.path.split('/').at(-1) === ELECTRON.archive, 'UNEXPECTED_ELECTRON_ARCHIVE');
  }
  const matches = entries.filter(entry => entry.path.split('/').at(-1) === ELECTRON.archive);
  requireThat(matches.length === 1 && total <= 513 * MiB, 'CACHE_ARCHIVE_NOT_UNIQUE');
  return matches[0].path;
}

async function direct(path, directory = false) {
  const stat = await lstat(path), actual = await realpath(path);
  requireThat(!stat.isSymbolicLink() && samePath(path, actual) &&
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1), 'REDIRECTED_OR_NONREGULAR_INPUT');
  return stat;
}
const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => a[key] === b[key]);
async function bytes(path, limit) {
  const before = await direct(path);
  requireThat(before.size > 0 && before.size <= limit, 'INPUT_SIZE_BOUND');
  const raw = await readFile(path), after = await direct(path);
  requireThat(unchanged(before, after) && raw.length === before.size, 'INPUT_CHANGED');
  return raw;
}
async function fileHash(path, limit) {
  const before = await direct(path);
  requireThat(before.size > 0 && before.size <= limit, 'INPUT_SIZE_BOUND');
  const handle = await open(path, 'r');
  try {
    requireThat(unchanged(before, await handle.stat()), 'INPUT_CHANGED');
    const digest = createHash('sha256'); let count = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      count += chunk.length; requireThat(count <= limit, 'INPUT_SIZE_BOUND'); digest.update(chunk);
    }
    requireThat(count === before.size && unchanged(before, await handle.stat()) && unchanged(before, await direct(path)), 'INPUT_CHANGED');
    return digest.digest('hex');
  } finally { await handle.close(); }
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('FRESH_OUTPUT_REQUIRED');
}
async function existingDirectory(path) {
  try { await direct(path, true); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await direct(dirname(path), true); await mkdir(path); await direct(path, true);
  }
}
async function cacheInventory(root) {
  const files = []; let directories = 0;
  async function walk(directory, depth) {
    requireThat(depth <= 8 && ++directories <= 64, 'CACHE_INVENTORY_BOUND');
    await direct(directory, true);
    const names = await readdir(directory); requireThat(names.length <= 64, 'CACHE_INVENTORY_BOUND');
    for (const name of names) {
      const path = join(directory, name), stat = await lstat(path);
      if (stat.isDirectory()) await walk(path, depth + 1);
      else {
        const observed = await direct(path); files.push({ path: relative(root, path).split('\\').join('/'), bytes: observed.size });
        requireThat(files.length <= 32, 'CACHE_INVENTORY_BOUND');
      }
    }
  }
  await walk(root, 0); return files;
}
async function verificationDirectories(root) {
  try { await direct(root, true); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const names = await readdir(root); requireThat(names.length <= 128, 'VERIFICATION_DIRECTORY_BOUND');
  return names.filter(name => /^windows-executable-[a-zA-Z0-9_-]{6}$/.test(name));
}
function ownedDirectory(path, root, prefix) {
  const part = relative(root, path);
  requireThat(typeof path === 'string' && part.length > prefix.length && !part.includes('/') && !part.includes('\\') &&
    part.startsWith(prefix) && samePath(dirname(path), root), 'UNOWNED_COMPONENT_OUTPUT');
  return path;
}

export async function checkPackagedComponentCi() {
  requireThat(arguments.length === 0, 'NO_COMPONENT_OPTIONS');
  requireThat(process.release.name === 'node' && process.execArgv.length === 0, 'PLAIN_NODE_INVOCATION_REQUIRED');
  assertHostedEnvironment({ platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
    electronVersion: process.versions.electron, env: process.env });
  await direct(REPOSITORY, true);
  requireThat(samePath(REPOSITORY, process.env.GITHUB_WORKSPACE), 'WORKSPACE_MISMATCH');
  const runtime = join(REPOSITORY, 'runtime'); await existingDirectory(runtime);
  const artifacts = join(runtime, 'ci-desktop-smoke-artifacts'); await absent(artifacts); await mkdir(artifacts);
  const run = await mkdtemp(join(runtime, 'ci-component-')); await direct(run, true);
  const cache = join(run, 'electron-cache'); await mkdir(cache);
  let phase = 'preflight', reportDirectory = null, bundle = null, head = null, beforeReports = null, artifactBytes = 0;
  let nativeProgress = null, installerOutcome = null;
  const copied = new Set(), artifactHashes = {};
  const verificationRoot = join(runtime, 'verification');
  async function receipt(name, value) {
    requireThat(ARTIFACT_FILES.includes(name) && name.endsWith('.json'), 'ARTIFACT_NAME_REFUSED');
    const raw = Buffer.from(JSON.stringify(value, null, 2) + '\n'); requireThat(raw.length <= 128 * 1024, 'RECEIPT_SIZE_BOUND');
    await direct(artifacts, true);
    const temp = join(run, name + '.partial'); await absent(temp);
    await writeFile(temp, raw, { flag: 'wx' }); await rename(temp, join(artifacts, name));
  }
  async function progress(status) {
    await receipt('progress.json', { schemaVersion: 1, kind: 'arcane-packaged-component-ci-progress', phase, status,
      gitSha: head, ...BOUNDARIES });
  }
  async function copyArtifact(name, from, limit) {
    if (copied.has(name)) return;
    requireThat(ARTIFACT_FILES.includes(name), 'ARTIFACT_NAME_REFUSED');
    let raw;
    try { raw = await bytes(from, limit); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (name.endsWith('.json')) requireThat(object(JSON.parse(raw.toString('utf8'))), 'ARTIFACT_JSON_INVALID');
    else requireThat(name === 'workspace.png' && raw.length >= 33 && raw.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      raw.toString('ascii', 12, 16) === 'IHDR' && raw.readUInt32BE(16) > 0 && raw.readUInt32BE(16) <= 8192 &&
      raw.readUInt32BE(20) > 0 && raw.readUInt32BE(20) <= 8192, 'SCREENSHOT_INVALID');
    requireThat(artifactBytes + raw.length <= 32 * MiB, 'ARTIFACT_TOTAL_BOUND');
    await writeFile(join(artifacts, name), raw, { flag: 'wx' });
    artifactBytes += raw.length; artifactHashes[name] = sha(raw); copied.add(name);
  }
  async function collect() {
    if (bundle) await copyArtifact('windows-manifest.json', join(bundle.directory, 'windows-manifest.json'), 16 * MiB);
    if (!reportDirectory && beforeReports) {
      const added = (await verificationDirectories(verificationRoot)).filter(name => !beforeReports.includes(name));
      requireThat(added.length <= 1, 'AMBIGUOUS_VERIFICATION_OUTPUT');
      if (added.length) reportDirectory = join(verificationRoot, added[0]);
    }
    if (!reportDirectory) return;
    ownedDirectory(reportDirectory, verificationRoot, 'windows-executable-'); await direct(reportDirectory, true);
    try {
      const observed = JSON.parse(await bytes(join(reportDirectory, 'progress.json'), 128 * 1024));
      if (observed.schemaVersion === 1 && observed.kind === 'arcane-executable-verifier-progress' &&
        ['created', 'verify-before', 'runtime-imports', 'mcp-runtime', 'launch', 'report', 'parent-loss', 'verify-after', 'complete'].includes(observed.phase) &&
        ['running', 'failed', 'passed', 'process-exited'].includes(observed.status)) nativeProgress = { phase: observed.phase, status: observed.status };
    } catch { nativeProgress = null; } // An unavailable progress projection never grants success or hides other fixed evidence.
    for (const [name, path, limit] of [
      ['verification.json', 'verification.json', 128 * 1024], ['process-outcome.json', 'process-outcome.json', 128 * 1024],
      ['mcp-runtime.json', 'mcp-runtime.json', 128 * 1024], ['app-checks.json', 'app/checks.json', 128 * 1024],
      ['workspace.png', 'app/workspace.png', 8 * MiB], ['app-error.json', 'app/error.json', 128 * 1024],
    ]) await copyArtifact(name, join(reportDirectory, path), limit);
  }
  try {
    await progress('running');
    // Lazy imports keep metadata/refusal tests free of product or native startup.
    const { runBoundedChild, checkWindowsExecutable, smokeChecksComplete, REQUIRED_SMOKE_CHECKS } = await import('./check-windows-executable.mjs');
    const childEnv = acquisitionEnvironment(process.env, cache);
    const git = await runBoundedChild('git', ['rev-parse', '--verify', 'HEAD'], { cwd: REPOSITORY, env: childEnv, deadlineMs: 10000, maxOutputBytes: 1024 });
    requireThat(git.code === 0 && git.signal === null, 'SOURCE_HEAD_UNAVAILABLE');
    head = git.output.trim(); assertSourceIdentity(head, process.env.GITHUB_SHA);
    const clean = await runBoundedChild('git', ['diff', '--no-ext-diff', '--quiet', 'HEAD', '--', '.'],
      { cwd: REPOSITORY, env: childEnv, deadlineMs: 10000, maxOutputBytes: 1024 });
    requireThat(clean.code === 0 && clean.signal === null && clean.outputBytes === 0, 'TRACKED_SOURCE_NOT_CLEAN');
    phase = 'toolchain'; await progress('running');
    const electronRoot = join(REPOSITORY, 'node_modules', 'electron'); await direct(electronRoot, true);
    const names = { package: join(REPOSITORY, 'package.json'), lock: join(REPOSITORY, 'package-lock.json'),
      installed: join(electronRoot, 'package.json'), installer: join(electronRoot, 'install.js'), checksums: join(electronRoot, 'checksums.json') };
    const raw = {};
    for (const [key, path] of Object.entries(names)) raw[key] = await bytes(path, key === 'lock' ? 4 * MiB : MiB);
    validateElectronMetadata({ pkg: JSON.parse(raw.package), lock: JSON.parse(raw.lock), installed: JSON.parse(raw.installed),
      installerSha256: sha(raw.installer), checksumsSha256: sha(raw.checksums), checksums: JSON.parse(raw.checksums) });
    const dist = join(electronRoot, 'dist'); await absent(dist); await absent(join(electronRoot, 'path.txt'));
    const nodeExecutable = await realpath(process.execPath); requireThat(samePath(nodeExecutable, process.execPath) && basename(nodeExecutable).toLowerCase() === 'node.exe', 'ACTUAL_NODE_REQUIRED');
    let nodeLicense = null;
    for (const name of ['LICENSE', 'LICENSE.txt']) {
      const path = join(dirname(nodeExecutable), name);
      try { await direct(path); nodeLicense = path; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    requireThat(nodeLicense !== null, 'ADJACENT_NODE_LICENSE_UNAVAILABLE');
    const licenseRaw = await bytes(nodeLicense, MiB); requireThat(licenseRaw.length >= 50000, 'COMPLETE_NODE_LICENSE_REQUIRED');
    const toolchain = { schemaVersion: 1, kind: 'arcane-component-ci-toolchain', gitSha: head,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      packageSha256: sha(raw.package), lockSha256: sha(raw.lock),
      node: { version: process.versions.node, platform: process.platform, arch: process.arch,
        executableSha256: await fileHash(nodeExecutable, 128 * MiB), licenseSha256: sha(licenseRaw), licenseSource: 'adjacent-to-actual-runtime' },
      electron: { ...ELECTRON, installedPackageSha256: sha(raw.installed), acquisition: 'not-started' },
      canonicalScripts: { packageSha256: sha(await bytes(join(REPOSITORY, 'scripts/package-windows.mjs'), MiB)),
        verifierSha256: sha(await bytes(join(REPOSITORY, 'scripts/check-windows-executable.mjs'), MiB)),
        driverSha256: sha(await bytes(fileURLToPath(import.meta.url), MiB)) }, ...BOUNDARIES };
    await receipt('toolchain.json', toolchain);
    phase = 'electron-install'; await progress('running');
    // The only package code explicitly activated is the verified official installer.
    let installed;
    try {
      installed = await runBoundedChild(nodeExecutable, [names.installer],
        { cwd: REPOSITORY, env: childEnv, deadlineMs: 180000, maxOutputBytes: 65536 });
      installerOutcome = { terminalAcknowledged: true, code: installed.code, signal: installed.signal,
        outputBytes: installed.outputBytes, outputSha256: sha(installed.output) };
    } catch (error) {
      const outcome = error?.outcome;
      installerOutcome = { terminalAcknowledged: object(outcome),
        code: Number.isInteger(outcome?.code) ? outcome.code : null,
        signal: typeof outcome?.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(outcome.signal) ? outcome.signal : null,
        outputBytes: Number.isSafeInteger(outcome?.outputBytes) && outcome.outputBytes >= 0 ? outcome.outputBytes : null };
      throw error;
    }
    requireThat(installed.code === 0 && installed.signal === null, 'ELECTRON_INSTALL_DID_NOT_SUCCEED');
    phase = 'electron-archive'; await progress('running');
    const archive = selectElectronArchive(await cacheInventory(cache));
    requireThat(await fileHash(join(cache, archive), 512 * MiB) === ELECTRON.archiveSha256, 'DOWNLOADED_ARCHIVE_HASH_MISMATCH');
    requireThat((await bytes(join(dist, 'version'), 128)).toString('utf8').trim().replace(/^v/, '') === ELECTRON.version &&
      (await bytes(join(electronRoot, 'path.txt'), 128)).toString('utf8') === 'electron.exe', 'ELECTRON_INSTALL_OUTPUT_MISMATCH');
    for (const [key, path] of Object.entries(names)) requireThat(sha(await bytes(path, key === 'lock' ? 4 * MiB : MiB)) === sha(raw[key]), 'TOOLCHAIN_METADATA_CHANGED');
    toolchain.electron.acquisition = 'owned-child-exited-and-archive-verified';
    toolchain.electron.installerExit = installerOutcome;
    await receipt('toolchain.json', toolchain);
    phase = 'package'; await progress('running');
    const { packageWindows } = await import('./package-windows.mjs');
    bundle = await packageWindows({ nodeLicense });
    ownedDirectory(bundle.directory, join(runtime, 'windows'), 'arcane-win32-x64-'); await direct(bundle.directory, true);
    await receipt('package-proof.json', bundle);
    const manifestRaw = await bytes(join(bundle.directory, 'windows-manifest.json'), 16 * MiB), manifest = JSON.parse(manifestRaw);
    requireThat(bundle.integrityOnly === true && bundle.signed === false && bundle.installer === false && bundle.installedNodeRequired === false &&
      bundle.applicationLaunchVerified === false && bundle.electronVersion === ELECTRON.version && packagedNodeVersionMatches(bundle.nodeVersion, process.versions.node) &&
      hash(bundle.manifestSha256) && bundle.manifestSha256 === sha(manifestRaw) && manifest.schemaVersion === 1 && manifest.kind === 'arcane-windows-directory' &&
      manifest.platform === 'win32' && manifest.arch === 'x64' && manifest.signed === false && manifest.installer === false &&
      manifest.electron?.version === ELECTRON.version && packagedNodeVersionMatches(manifest.node?.version, process.versions.node) &&
      manifest.runtime?.installedNodeRequired === false && manifest.runtime.dependenciesIncluded === true &&
      manifest.runtime.applicationLaunchVerified === false && manifest.runtime.inferenceStarted === false &&
      manifest.fileCount === bundle.files && manifest.totalBytes === bundle.bytes && manifest.files?.length === bundle.files &&
      manifest.files.find(file => file.path === 'resources/node/node.exe')?.sha256 === toolchain.node.executableSha256 &&
      manifest.files.find(file => file.path === 'resources/node/LICENSE')?.sha256 === toolchain.node.licenseSha256, 'PACKAGE_RETURN_MISMATCH');
    beforeReports = await verificationDirectories(verificationRoot);
    phase = 'verify'; await progress('running');
    const proof = await checkWindowsExecutable(bundle.directory);
    reportDirectory = ownedDirectory(proof.reportDirectory, verificationRoot, 'windows-executable-');
    const newReports = (await verificationDirectories(verificationRoot)).filter(name => !beforeReports.includes(name));
    requireThat(newReports.length === 1 && samePath(reportDirectory, join(verificationRoot, newReports[0])), 'VERIFIER_REPORT_NOT_FRESH');
    const verificationRaw = await bytes(join(reportDirectory, 'verification.json'), 128 * 1024), recorded = JSON.parse(verificationRaw);
    requireThat(JSON.stringify(proof) === JSON.stringify(recorded), 'VERIFIER_RECEIPT_MISMATCH');
    const appRaw = await bytes(join(reportDirectory, 'app/checks.json'), 128 * 1024), app = JSON.parse(appRaw);
    const outcomeRaw = await bytes(join(reportDirectory, 'process-outcome.json'), 128 * 1024), outcome = JSON.parse(outcomeRaw);
    const mcpRaw = await bytes(join(reportDirectory, 'mcp-runtime.json'), 128 * 1024), mcp = JSON.parse(mcpRaw);
    requireThat(proof.schemaVersion === 1 && samePath(proof.directory, bundle.directory) && samePath(proof.executable, bundle.executable) &&
      samePath(proof.screenshot, join(reportDirectory, 'app/workspace.png')) && proof.manifestSha256 === bundle.manifestSha256 &&
      proof.inferenceStarted === false && proof.studioOperations === 0 && proof.signed === false && proof.fullProductVerified === false &&
      REQUIRED_SMOKE_CHECKS.length > 0 && smokeChecksComplete(proof.checks) && smokeChecksComplete(app.checks) &&
      ['runtimeImportsVerified', 'parentLossShutdownVerified', 'mcpProtocolVerified', 'bundledGuidanceVerified', 'mcpShutdownVerified'].every(key => proof.checks[key] === true) &&
      app.schemaVersion === 1 && app.kind === 'arcane-windows-executable-smoke' && app.inferenceStarted === false && app.studioOperations === 0 &&
      app.signed === false && app.fullProductVerified === false && outcome.code === 0 && outcome.signal === null &&
      mcp.shutdownVerified === true && mcp.guidanceRead === true && mcp.code === 0 && mcp.signal === null && mcp.diagnosticBytes === 0 &&
      mcp.daemonRequests === 0 && mcp.inferenceStarted === false && mcp.studioOperations === 0, 'NATIVE_COMPONENT_PROOF_INCOMPLETE');
    requireThat(sha(await bytes(join(bundle.directory, 'windows-manifest.json'), 16 * MiB)) === bundle.manifestSha256, 'FINAL_MANIFEST_CHANGED');
    for (const [key, path] of Object.entries(names)) requireThat(sha(await bytes(path, key === 'lock' ? 4 * MiB : MiB)) === sha(raw[key]), 'FINAL_TOOLCHAIN_METADATA_CHANGED');
    const finalHead = await runBoundedChild('git', ['rev-parse', '--verify', 'HEAD'], { cwd: REPOSITORY, env: childEnv, deadlineMs: 10000, maxOutputBytes: 1024 });
    requireThat(finalHead.code === 0 && finalHead.signal === null, 'FINAL_SOURCE_HEAD_UNAVAILABLE');
    assertSourceIdentity(finalHead.output.trim(), head);
    phase = 'artifacts'; await progress('running'); await collect();
    requireThat(['windows-manifest.json', 'verification.json', 'process-outcome.json', 'mcp-runtime.json', 'app-checks.json', 'workspace.png'].every(name => copied.has(name)), 'REQUIRED_ARTIFACT_MISSING');
    requireThat(artifactHashes['windows-manifest.json'] === bundle.manifestSha256 &&
      [['verification.json', verificationRaw], ['process-outcome.json', outcomeRaw], ['mcp-runtime.json', mcpRaw], ['app-checks.json', appRaw]]
        .every(([name, raw]) => artifactHashes[name] === sha(raw)), 'COPIED_EVIDENCE_CHANGED');
    const success = { schemaVersion: 1, kind: 'arcane-packaged-component-ci', status: 'passed', gitSha: head,
      lockSha256: toolchain.lockSha256, nodeVersion: process.versions.node, electronVersion: ELECTRON.version,
      manifestSha256: bundle.manifestSha256, files: bundle.files, bytes: bundle.bytes,
      executableSmokeVerified: true, ownedShutdownChecksVerified: true, artifactSha256: artifactHashes, ...BOUNDARIES };
    phase = 'complete'; await progress('passed'); await receipt('success.json', success); return success;
  } catch (error) {
    let collectionComplete = false;
    try { await collect(); collectionComplete = true; } catch { /* Never replace the first failed phase or retry native work. */ }
    const code = FAILURE_CODES.has(error?.message) ? error.message :
      phase === 'verify' ? 'EXECUTABLE_VERIFIER_FAILED' : phase === 'package' ? 'WINDOWS_PACKAGER_FAILED' : 'COMPONENT_SMOKE_FAILED';
    try { await receipt('failure.json', { schemaVersion: 1, kind: 'arcane-packaged-component-ci-failure', status: 'failed', phase,
      code, gitSha: head, artifactCollectionComplete: collectionComplete,
      installerOutcome, nativeProgress,
      processClosure: 'only-canonical-success-receipts-establish-owned-shutdown', ...BOUNDARIES }); } catch { /* Fixed stderr remains authoritative. */ }
    try { await progress('failed'); } catch { /* No diagnostic replay or cleanup is attempted. */ }
    throw new Error('Packaged component CI failed; inspect the fixed metadata artifacts. No automatic retry was attempted.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { process.stderr.write('Usage: node scripts/check-packaged-component-ci.mjs\n'); process.exitCode = 1; }
  else checkPackagedComponentCi().then(result => process.stdout.write(JSON.stringify(result) + '\n'),
    () => { process.stderr.write('Packaged component CI failed. Inspect runtime/ci-desktop-smoke-artifacts when present; no retry was attempted.\n'); process.exitCode = 1; });
}
