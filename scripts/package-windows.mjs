import { createHash } from 'node:crypto';
import { constants, write as writeDiagnostic } from 'node:fs';
import { copyFile, readFile, writeFile, readdir, lstat, realpath, mkdir, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, relative, dirname, isAbsolute, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalRelease, verifyLocalRelease, inside, REQUIRED_FRONTEND_FILES } from './create-local-release.mjs';
import { REQUIRED_MANAGED_LUAU_FILES } from './managed-luau-compiler.mjs';
import { copyInBatches, COPY_BATCH_FILES, COPY_BATCH_BYTES } from './bounded-copy.mjs';
import { createPackageProgress } from './package-progress.mjs';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const MANIFEST = 'windows-manifest.json';
const deploymentPath = path => !path.startsWith('tests/') && !path.startsWith('dist/tests/');
function deploymentManifest(source) {
  const files = source.files.filter(file => deploymentPath(file.path));
  return { ...source, fileCount: files.length, totalBytes: files.reduce((total, file) => total + file.bytes, 0), files };
}
const HOST_FILES = ['main.cjs', 'diagnostics-host.cjs', 'diagnostics-storage.cjs', 'diagnostics-directory.cjs', 'policy.cjs', 'preload.cjs', 'code-verification.cjs', 'provider-setup.cjs', 'provider-login.cjs', 'studio-key-vault.cjs', 'workspace-preferences.cjs', 'runtime-recovery.cjs', 'native-handoff.cjs', 'native-handoff-host.cjs', 'app-asset-host.cjs', 'native-handoff-ipc.cjs', 'claude-chat.cjs', 'arcane-chat.cjs', 'plugin-install.cjs', 'in-app-dialog.cjs', 'project-permissions.cjs', 'billing.cjs', 'build-notifications.cjs', 'pyx-bar-host.cjs', 'pyx-preload.cjs', 'mesh-keep.cjs', 'asset-import.cjs', 'desktop-updates.cjs', 'trusted-dialog.cjs', 'trusted-dialog-preload.cjs', 'trusted-dialog.html', 'trusted-dialog.css', 'trusted-dialog.js'];
const PRODUCTION_ROOTS = ['@modelcontextprotocol/sdk', 'zod'];
const ELECTRON_FILES = new Set([
  'electron.exe', 'LICENSE', 'LICENSES.chromium.html', 'version',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'ffmpeg.dll', 'd3dcompiler_47.dll',
  'dxcompiler.dll', 'dxil.dll', 'libEGL.dll', 'libGLESv2.dll',
  'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
]);
const ELECTRON_REQUIRED = [
  'Arcane.exe', 'LICENSE', 'LICENSES.chromium.html', 'version', 'resources.pak',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'icudtl.dat', 'ffmpeg.dll',
  'v8_context_snapshot.bin',
];
const FORBIDDEN = /^(?:\.env(?:\..*)?|\.npmrc|auth\.json|credentials\.json|daemon\.json|preferences\.json|.*\.(?:log|key|pem|partial))$/i;
const PRIVATE_DIRECTORIES = new Set(['runtime', '.runtime', '.git', '.codex', '.claude', '.agents', 'cache', '__pycache__', 'generated']);
const DEPENDENCY_CODE_DIRECTORIES = new Set(['runtime', 'cache', 'generated']);
const DEPENDENCY_OMISSIONS = new Set(['node_modules', 'test', 'tests', '__tests__', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.esm.json', 'tsconfig.cjs.json', 'tsconfig.base.json', ...[...PRIVATE_DIRECTORIES].filter(name => !DEPENDENCY_CODE_DIRECTORIES.has(name))]);
const MAX_FILES = 32768, MAX_FILE_BYTES = 512 * 1024 * 1024, MAX_BYTES = 2 * 1024 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const canonical = value => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
const diagnosticPath = value => typeof value === 'string' && value.length <= 4096 ? value : null;

function annotateFailure(error, key, value) {
  // Diagnostic metadata cannot replace a frozen error or make a failed check pass.
  try {
    if (error instanceof Error && Object.isExtensible(error) && !Object.hasOwn(error, key)) {
      Object.defineProperty(error, key, { value: Object.freeze(value), enumerable: true });
    }
  } catch { /* Preserve the original thrown value even if annotation is unavailable. */ }
}

function safeRelative(path, dependency = path.startsWith('resources/product/node_modules/')) {
  if (typeof path !== 'string' || path.length > 1024 || path.includes('\\') ||
      !/^[A-Za-z0-9_@.+\-/]+$/.test(path)) throw new Error('Invalid Windows bundle path.');
  const segments = path.split('/');
  if (segments.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
      FORBIDDEN.test(part) || (PRIVATE_DIRECTORIES.has(part.toLowerCase()) && !(dependency && DEPENDENCY_CODE_DIRECTORIES.has(part.toLowerCase()))))) throw new Error('Forbidden Windows bundle path.');
  return path;
}

// lstat + realpath are authoritative for OneDrive placeholders; Dirent/reparse
// attributes alone do not distinguish a cloud file from a real redirect.
async function checkedPath(path, directory = false) {
  let operation = 'lstat';
  try {
    const stat = await lstat(path);
    operation = 'realpath';
    const actual = await realpath(path);
    operation = 'identity';
    if (stat.isSymbolicLink() || !samePath(resolve(path), actual) ||
        (directory ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES))) {
      throw new Error('Expected a regular unredirected ' + (directory ? 'directory' : 'single-link file') + '.');
    }
    return stat;
  } catch (error) {
    annotateFailure(error, 'pathValidation', { operation, expected: directory ? 'directory' : 'single-link-file', path: diagnosticPath(path) });
    throw error;
  }
}
async function safeParents(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { await checkedPath(current, true); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) return;
  }
}
async function regularBytes(path, expected) {
  const before = await checkedPath(path);
  if (expected && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some(key => before[key] !== expected[key])) {
    throw new Error('Dependency changed since inventory; incomplete owned output retained.');
  }
  const bytes = await readFile(path), after = await checkedPath(path);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    throw new Error('Packaging input changed while reading; retry after writers finish.');
  }
  return bytes;
}
async function json(path) { return JSON.parse((await regularBytes(path)).toString('utf8')); }
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export function hasPrivateKeyMaterial(text) {
  // Parser/library format markers are not credentials. Encoded bodies, including
  // escaped source/map newlines and unfinished material, remain refused.
  const normalized = text.replace(/\\{1,4}[rn]/g, '\n');
  return /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{32,}/.test(normalized);
}
function secretCheck(bytes, path) {
  if (bytes.length > 32 * 1024 * 1024) return; // Binaries are bounded and structurally selected.
  const text = bytes.toString('utf8');
  if (/arcane_local_v1_\d+_[a-f0-9]{64}\b/.test(text) ||
      /http:\/\/127\.0\.0\.1:\d+\/(?:studio)?#[a-f0-9]{64}\b/.test(text) ||
      hasPrivateKeyMaterial(text)) throw new Error('Credential material in bundle input: ' + path);
  if (!path.endsWith('.json')) return;
  const visit = (value, depth = 0) => {
    if (depth > 64) throw new Error('Overdeep bundle JSON.');
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:access_token|refresh_token|client_secret|password|authorization|apiKey|token)$/i.test(key) &&
          typeof item === 'string' && item.length) throw new Error('Credential-like JSON field in bundle input: ' + path);
      visit(item, depth + 1);
    }
  };
  try { visit(JSON.parse(text)); } catch (error) { if (error instanceof SyntaxError) throw new Error('Non-strict JSON packaging input: ' + path); throw error; }
}
function windowsX64Exe(bytes, label) {
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error(label + ' is not a Windows x64 PE executable.');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset < 64 || offset + 26 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550 ||
      bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 24) !== 0x20b ||
      !(bytes.readUInt16LE(offset + 22) & 2) || (bytes.readUInt16LE(offset + 22) & 0x2000)) {
    throw new Error(label + ' is not a Windows x64 PE executable.');
  }
}
function validateNode(info) {
  if (!info || info.platform !== 'win32' || info.arch !== 'x64' || info.electron ||
      !/^v\d+\.\d+\.\d+$/.test(info.version) || Number(info.version.split('.')[0].slice(1)) < 24) {
    throw new Error('Bundled Node must be standalone stable Node >=24 for Windows x64.');
  }
  return { version: info.version, platform: 'win32', arch: 'x64' };
}
export async function probeNodeRuntime(executable) {
  windowsX64Exe(await regularBytes(executable), 'Node');
  // Fixed argv, no shell, preload, provider, daemon, network, or ElectronRunAsNode.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)));
  const { stdout } = await run(executable, ['--input-type=commonjs', '-e',
    'console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,electron:process.versions.electron??null}))'],
  { cwd: dirname(executable), env, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 4096 });
  return validateNode(JSON.parse(stdout.trim()));
}
function validateNodeLicense(bytes) {
  const text = bytes.toString('utf8');
  // A Node distribution's full LICENSE includes third-party notices. Refuse a
  // short MIT extract; byte/hash identity is recorded, not a legal certification.
  if (bytes.length < 50000 || !text.startsWith('Node.js is licensed for use as follows:') ||
      !text.includes('Permission is hereby granted, free of charge') ||
      !text.includes('externally maintained libraries') ||
      !['Acorn', 'OpenSSL', 'libuv', 'V8'].every(name => text.includes(name))) {
    throw new Error('A complete official Node LICENSE, including bundled third-party notices, is required.');
  }
}
async function nodeLicensePath(repository, executable, supplied) {
  if (supplied !== undefined) {
    if (!isAbsolute(supplied)) throw new Error('--node-license requires an absolute file path.');
    return resolve(supplied);
  }
  for (const candidate of [join(dirname(executable), 'LICENSE'), join(dirname(executable), 'LICENSE.txt'),
    join(repository, 'apps/desktop/electron/node-LICENSE.txt')]) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error('Missing complete Node LICENSE. Supply --node-license ABSOLUTE_LICENSE_FILE or apps/desktop/electron/node-LICENSE.txt from the exact official Node version.');
}
function packageName(name) {
  if (typeof name !== 'string' || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error('Invalid dependency name.');
  return name;
}
function dependencyKey(from, name, packages) {
  packageName(name);
  for (let current = from; ; current = posix.dirname(current)) {
    if (posix.basename(current) !== 'node_modules') {
      const candidate = (current && current !== '.' ? current + '/' : '') + 'node_modules/' + name;
      if (packages[candidate]) return candidate;
    }
    if (!current || current === '.') return undefined;
  }
}
function compatible(list, expected) {
  return !list || (Array.isArray(list) && !list.includes('!' + expected) &&
    (!list.some(item => !item.startsWith('!')) || list.includes(expected) || list.includes('any')));
}
async function productionDependencies(repository, pkg, lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.[''] ||
      canonical(pkg.dependencies) !== canonical(lock.packages[''].dependencies) ||
      canonical(pkg.devDependencies) !== canonical(lock.packages[''].devDependencies) ||
      canonical(pkg.dependencies) !== canonical(Object.fromEntries(PRODUCTION_ROOTS.map(name => [name, pkg.dependencies?.[name]])))) {
    throw new Error('Expected the locked Arcane production roots @modelcontextprotocol/sdk and zod only.');
  }
  const pending = PRODUCTION_ROOTS.map(name => {
    const key = dependencyKey('', name, lock.packages);
    if (!key) throw new Error('Missing required locked dependency: ' + name);
    return key;
  });
  const selected = new Map();
  while (pending.length) {
    const key = pending.shift();
    if (selected.has(key)) continue;
    safeRelative(key);
    const recorded = lock.packages[key];
    if (recorded.link || recorded.dev || !compatible(recorded.os, 'win32') || !compatible(recorded.cpu, 'x64')) {
      throw new Error('Production dependency is linked, development-only, or incompatible: ' + key);
    }
    const installed = await json(join(repository, key, 'package.json'));
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (installed.name !== name || installed.version !== recorded.version) throw new Error('Installed dependency differs from lock: ' + key);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (canonical(installed[field]) !== canonical(recorded[field])) throw new Error('Installed dependency edges differ from lock: ' + key);
    }
    selected.set(key, { path: key, name, version: recorded.version });
    const dependencies = { ...recorded.dependencies, ...recorded.optionalDependencies };
    const edges = new Map(Object.keys(dependencies).map(name => [name, !!recorded.optionalDependencies?.[name]]));
    for (const name of Object.keys(recorded.peerDependencies ?? {})) {
      if (!edges.has(name) && !recorded.peerDependenciesMeta?.[name]?.optional) edges.set(name, false);
    }
    for (const [name, optional] of edges) {
      const next = dependencyKey(key, name, lock.packages), entry = lock.packages[next];
      const eligible = entry && compatible(entry.os, 'win32') && compatible(entry.cpu, 'x64');
      if ((!eligible || !(await exists(join(repository, next, 'package.json')))) && optional) continue;
      if (!eligible) throw new Error('Missing/incompatible required transitive dependency: ' + name);
      pending.push(next);
    }
    if (selected.size > 1024) throw new Error('Dependency budget exceeded.');
  }
  return [...selected.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
async function walk(directory, visit, omit = () => false, prefix = '', dependency = false) {
  await checkedPath(directory, true);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const child = prefix ? prefix + '/' + entry.name : entry.name;
    if (omit(child, entry.name)) continue;
    safeRelative(child, dependency || child.startsWith('resources/product/node_modules/'));
    const target = join(directory, entry.name), stat = await lstat(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(target, visit, omit, child, dependency);
    else { await checkedPath(target); await visit(target, child); }
  }
}
function electronPath(path) {
  return ELECTRON_FILES.has(path) ||
    /^locales\/[A-Za-z0-9_-]+\.pak$/.test(path);
}
function appPackage(version) {
  return { name: 'arcane-desktop', productName: 'Arcane', version, private: true, main: 'main.cjs', type: 'commonjs' };
}

/** Trusted build API. Paths and the Node probe are injectable for offline fixtures,
 * never accepted from HTTP/IPC. The CLI always uses the real executable probe. */
export async function packageWindows(options = {}) {
  const context = { phase: 'validate-inputs', outputDirectory: null, lastBundlePath: null };
  // Trusted build callback only. It receives fixed diagnostic metadata and must
  // return a promise covering all of its writes; it cannot grant verification.
  const progress = createPackageProgress(options.onProgress);
  let result;
  try {
    await progress.phase(context.phase);
    result = await assembleWindowsPackage(options, context, progress);
  }
  catch (error) {
    annotateFailure(error, 'packageContext', { ...context, outputDirectory: diagnosticPath(context.outputDirectory) });
    await progress.finish(true, error);
    throw error;
  }
  await progress.finish(false);
  return result;
}
async function assembleWindowsPackage({ repository = REPOSITORY, electronDist,
  nodeExecutable = process.execPath, nodeLicense, inspectNode = probeNodeRuntime } = {}, context, progress) {
  repository = resolve(repository);
  await checkedPath(repository, true);
  electronDist = resolve(electronDist ?? join(repository, 'node_modules/electron/dist'));
  nodeExecutable = resolve(nodeExecutable);
  const pkg = await json(join(repository, 'package.json')), lock = await json(join(repository, 'package-lock.json'));
  if (pkg.name !== 'arcane' || pkg.engines?.node !== '>=24') throw new Error('Expected the Arcane Node >=24 package.');
  const electronPackage = await json(join(dirname(electronDist), 'package.json'));
  const electronVersion = (await regularBytes(join(electronDist, 'version'))).toString('utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(pkg.devDependencies?.electron) ||
      pkg.devDependencies.electron !== lock.packages?.['node_modules/electron']?.version ||
      electronPackage.name !== 'electron' || electronPackage.version !== pkg.devDependencies.electron ||
      electronVersion !== electronPackage.version) throw new Error('Install the exact pinned Electron distribution before packaging.');
  windowsX64Exe(await regularBytes(join(electronDist, 'electron.exe')), 'Electron');
  windowsX64Exe(await regularBytes(nodeExecutable), 'Node');
  const node = validateNode(await inspectNode(nodeExecutable));
  const licensePath = await nodeLicensePath(repository, nodeExecutable, nodeLicense);
  validateNodeLicense(await regularBytes(licensePath));
  const hostRoot = join(repository, 'apps/desktop/electron');
  for (const file of HOST_FILES) await regularBytes(join(hostRoot, file));
  context.phase = 'resolve-dependencies';
  await progress.phase(context.phase);
  const dependencies = await productionDependencies(repository, pkg, lock);

  // This API owns the source/compiled-map proof and excludes root runtime,
  // credentials, generated client configurations and dependency/user caches.
  context.phase = 'prepare-source-release';
  await progress.phase(context.phase);
  const release = await createLocalRelease({ repository });
  const releaseProof = await verifyLocalRelease(release.directory);
  const releaseManifest = await json(join(release.directory, 'release-manifest.json'));
  for (const required of ['dist/apps/daemon/src/diagnostic-reporter.js', 'dist/packages/diagnostics/src/report.js', 'dist/packages/diagnostics/src/outbox.js']) {
    if (!releaseManifest.files.some(file => file.path === required)) throw new Error('Diagnostic runtime is absent from the verified source release: ' + required);
  }
  if (releaseManifest.version !== pkg.version ||
      hash(await regularBytes(join(repository, 'package.json'))) !== releaseManifest.files.find(file => file.path === 'package.json')?.sha256 ||
      hash(await regularBytes(join(repository, 'package-lock.json'))) !== releaseManifest.files.find(file => file.path === 'package-lock.json')?.sha256) {
    throw new Error('Package metadata changed before the source snapshot.');
  }
  for (const file of [...HOST_FILES, ...(await exists(join(hostRoot, 'icon.png')) ? ['icon.png'] : [])]) {
    const entry = releaseManifest.files.find(entry => entry.path === 'apps/desktop/electron/' + file);
    if (!entry || hash(await regularBytes(join(hostRoot, file))) !== entry.sha256) {
      throw new Error('Host file is absent from or differs from the verified source snapshot: ' + file);
    }
  }
  context.phase = 'create-output';
  await progress.phase(context.phase);
  const outputRoot = join(repository, 'runtime/windows');
  await safeParents(outputRoot); await mkdir(outputRoot, { recursive: true }); await checkedPath(outputRoot, true);
  const directory = await mkdtemp(join(outputRoot, 'arcane-win32-x64-'));
  context.outputDirectory = directory;
  await checkedPath(directory, true);
  const files = [], sourceChecks = [], seen = new Set(); let totalBytes = 0;
  const add = async (path, bytes, source) => {
    safeRelative(path);
    context.lastBundlePath = path;
    if (seen.has(path.toLowerCase())) throw new Error('Duplicate/case-colliding bundle path.');
    seen.add(path.toLowerCase());
    totalBytes += bytes.length;
    if (files.length >= MAX_FILES || totalBytes > MAX_BYTES || bytes.length > MAX_FILE_BYTES) throw new Error('Windows bundle budget exceeded.');
    secretCheck(bytes, path);
    const target = join(directory, ...path.split('/'));
    if (!inside(directory, target)) throw new Error('Bundle output escapes owned directory.');
    await safeParents(dirname(target)); await mkdir(dirname(target), { recursive: true });
    if (source) {
      await copyFile(source, target, constants.COPYFILE_EXCL);
      if (hash(await regularBytes(target)) !== hash(bytes)) throw new Error('Input changed during copy; incomplete owned output retained.');
      sourceChecks.push({ source, sha256: hash(bytes) });
    } else await writeFile(target, bytes, { flag: 'wx' });
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  };
  const copy = async (source, path, expected) => add(path, await regularBytes(source, expected), source);
  context.phase = 'copy-electron';
  await progress.phase(context.phase);
  await walk(electronDist, async (source, path) => {
    if (!electronPath(path)) throw new Error('Unexpected Electron distribution payload: ' + path);
    await copy(source, path === 'electron.exe' ? 'Arcane.exe' : path);
  }, path => path === 'resources/default_app.asar');
  for (const file of ELECTRON_REQUIRED) if (!seen.has(file.toLowerCase())) throw new Error('Incomplete Electron distribution: ' + file);
  if (!files.some(file => file.path.startsWith('locales/'))) throw new Error('Missing Electron locales.');
  context.phase = 'copy-host'; context.lastBundlePath = null;
  await progress.phase(context.phase);
  await add('resources/app/package.json', Buffer.from(JSON.stringify(appPackage(pkg.version), null, 2) + '\n'));
  for (const file of HOST_FILES) await copy(join(hostRoot, file), 'resources/app/' + file);
  if (await exists(join(hostRoot, 'icon.png'))) {
    const icon = await regularBytes(join(hostRoot, 'icon.png'));
    if (icon.length <= 8 || !icon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid host icon PNG.');
    await copy(join(hostRoot, 'icon.png'), 'resources/app/icon.png');
  }
  context.phase = 'copy-node'; context.lastBundlePath = null;
  await progress.phase(context.phase);
  await copy(nodeExecutable, 'resources/node/node.exe');
  await copy(licensePath, 'resources/node/LICENSE');
  context.phase = 'copy-product'; context.lastBundlePath = null;
  await progress.phase(context.phase);
  const deployedManifest = deploymentManifest(releaseManifest);
  for (const entry of deployedManifest.files) await copy(join(release.directory, entry.path), 'resources/product/' + entry.path);
  const deployedManifestBytes = Buffer.from(JSON.stringify(deployedManifest, null, 2) + '\n');
  await add('resources/product/release-manifest.json', deployedManifestBytes);
  // Retain the complete original integrity metadata, not test/private-key fixture payloads.
  await copy(join(release.directory, 'release-manifest.json'), 'resources/source-manifest.json');
  context.phase = 'copy-dependencies'; context.lastBundlePath = null;
  await progress.phase(context.phase);
  for (const dependency of dependencies) {
    const descriptors = [], inventorySeen = new Set();
    await walk(join(repository, dependency.path), async (source, path) => {
      const target = 'resources/product/' + dependency.path + '/' + path;
      safeRelative(target);
      const key = target.toLowerCase();
      if (seen.has(key) || inventorySeen.has(key)) throw new Error('Duplicate/case-colliding dependency path.');
      if (descriptors.length >= MAX_FILES - files.length) throw new Error('Windows bundle file budget exceeded.');
      const stat = await checkedPath(source);
      const expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].map(key => [key, stat[key]]));
      inventorySeen.add(key);
      descriptors.push({ source, path: target, bytes: stat.size, expected });
    }, (_path, name) => name.startsWith('.') || DEPENDENCY_OMISSIONS.has(name.toLowerCase()), '', true);
    const diagnostic = { dependency: dependency.path, total: descriptors.length, completed: 0,
      batchFiles: COPY_BATCH_FILES, batchBytes: COPY_BATCH_BYTES, firstFailedPath: null };
    context.dependencyCopy = diagnostic;
    await copyInBatches(descriptors, async descriptor => {
      try {
        await copy(descriptor.source, descriptor.path, descriptor.expected);
        diagnostic.completed++;
        await progress.copied(descriptor.path, descriptor.bytes);
      } catch (error) {
        if (diagnostic.firstFailedPath === null) diagnostic.firstFailedPath = descriptor.path;
        throw error;
      }
    });
  }
  context.phase = 'recheck-sources'; context.lastBundlePath = null;
  await progress.phase(context.phase);
  for (const { source, sha256 } of sourceChecks) {
    if (hash(await regularBytes(source)) !== sha256) throw new Error('Packaging source changed; incomplete owned output retained for diagnosis.');
  }

  context.phase = 'brand-executable';
  await progress.phase(context.phase);
  let branding = { applied: false };
  // Build-only, pinned official resource editor. Never reachable from the app or renderer.
  if (pkg.devDependencies?.rcedit !== undefined) {
    const toolVersion = pkg.devDependencies.rcedit;
    const toolRoot = join(repository, 'node_modules/rcedit');
    const toolPackage = await json(join(toolRoot, 'package.json'));
    if (toolVersion !== '5.0.2' || toolPackage.name !== 'rcedit' || toolPackage.version !== toolVersion || lock.packages?.['node_modules/rcedit']?.version !== toolVersion) throw new Error('Expected the exact pinned build-only resource editor.');
    const tool = join(toolRoot, 'bin/rcedit-x64.exe');
    const toolBytes = await regularBytes(tool); windowsX64Exe(toolBytes, 'Resource editor');
    const icon = join(hostRoot, 'icon.ico'), iconBytes = await regularBytes(icon);
    if (iconBytes.length < 22 || iconBytes.readUInt16LE(0) !== 0 || iconBytes.readUInt16LE(2) !== 1 || iconBytes.readUInt16LE(4) !== 1 || iconBytes.readUInt32LE(18) !== 22 || iconBytes.readUInt32LE(14) !== iconBytes.length - 22) throw new Error('Invalid controlled Arcane icon.');
    const executable = join(directory, 'Arcane.exe');
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
    await run(tool, [executable, '--set-icon', icon, '--set-file-version', pkg.version, '--set-product-version', pkg.version,
      '--set-version-string', 'ProductName', 'Arcane', '--set-version-string', 'FileDescription', 'Arcane - Build worlds faster',
      '--set-version-string', 'InternalName', 'Arcane', '--set-version-string', 'OriginalFilename', 'Arcane.exe'],
      { shell: false, windowsHide: true, timeout: 30000, maxBuffer: 8192, env });
    const named = await run(tool, [executable, '--get-version-string', 'ProductName'], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 8192, env });
    if (named.stdout.trim() !== 'Arcane') throw new Error('Executable branding verification failed.');
    const brandedBytes = await regularBytes(executable); windowsX64Exe(brandedBytes, 'Arcane');
    const item = files.find(file => file.path === 'Arcane.exe'); totalBytes += brandedBytes.length - item.bytes;
    item.bytes = brandedBytes.length; item.sha256 = hash(brandedBytes);
    branding = { applied: true, productName: 'Arcane', toolVersion, toolSha256: hash(toolBytes), iconSha256: hash(iconBytes) };
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const manifest = {
    schemaVersion: 1, kind: 'arcane-windows-directory', createdAt: new Date().toISOString(),
    version: pkg.version, platform: 'win32', arch: 'x64', signed: false, installer: false, branding,
    electron: { version: electronVersion, executable: 'Arcane.exe', defaultAppIncluded: false },
    node: { ...node, executable: 'resources/node/node.exe', license: 'resources/node/LICENSE' },
    app: { entry: 'resources/app/main.cjs', productRoot: 'resources/product' },
    sourceRelease: { manifestSha256: hash(deployedManifestBytes), originalManifestSha256: releaseProof.manifestSha256, testPayloadsIncluded: false },
    runtime: { installedNodeRequired: false, dependenciesIncluded: true, applicationLaunchVerified: false, inferenceStarted: false },
    dependencies, fileCount: files.length, totalBytes, files,
  };
  context.phase = 'write-manifest';
  await progress.phase(context.phase);
  await writeFile(join(directory, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  context.phase = 'verify-output';
  await progress.phase(context.phase);
  const proof = await verifyWindowsBundle(directory);
  return { directory, executable: join(directory, 'Arcane.exe'), ...proof };
}

/** Integrity only: no execution of bundle code, daemon, providers or Studio. */
export async function verifyWindowsBundle(directory) {
  directory = resolve(directory); await checkedPath(directory, true);
  const manifestBytes = await regularBytes(join(directory, MANIFEST));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'arcane-windows-directory' ||
      manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.signed !== false || manifest.installer !== false ||
      !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES || manifest.fileCount !== manifest.files.length ||
      !Array.isArray(manifest.dependencies) || manifest.electron?.executable !== 'Arcane.exe' ||
      manifest.electron.defaultAppIncluded !== false || manifest.node?.executable !== 'resources/node/node.exe' ||
      manifest.node.license !== 'resources/node/LICENSE' || manifest.app?.entry !== 'resources/app/main.cjs' ||
      manifest.app.productRoot !== 'resources/product' || manifest.runtime?.installedNodeRequired !== false ||
      manifest.runtime.dependenciesIncluded !== true || manifest.runtime.applicationLaunchVerified !== false) throw new Error('Invalid Windows bundle manifest.');
  validateNode(manifest.node);
  const seen = new Set(); let totalBytes = 0;
  for (const entry of manifest.files) {
    const path = safeRelative(entry.path);
    if (path === MANIFEST || seen.has(path.toLowerCase()) || !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid Windows file descriptor.');
    seen.add(path.toLowerCase());
    const bytes = await regularBytes(join(directory, ...path.split('/'))); secretCheck(bytes, path);
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error('Windows bundle checksum mismatch: ' + path);
    totalBytes += bytes.length;
    if (totalBytes > MAX_BYTES) throw new Error('Windows bundle budget exceeded.');
  }
  await walk(directory, async (_source, path) => {
    if (path !== MANIFEST && !seen.has(path.toLowerCase())) throw new Error('Unlisted Windows bundle file: ' + path);
  });
  if (totalBytes !== manifest.totalBytes) throw new Error('Windows bundle byte count mismatch.');
  for (const path of [...ELECTRON_REQUIRED, 'resources/app/package.json', ...HOST_FILES.map(file => 'resources/app/' + file),
    'resources/node/node.exe', 'resources/node/LICENSE', 'resources/product/release-manifest.json',
    'resources/product/dist/apps/daemon/src/product-main.js', 'resources/product/dist/apps/mcp/src/main.js',
    'resources/product/dist/apps/daemon/src/diagnostic-reporter.js', 'resources/product/dist/packages/diagnostics/src/report.js', 'resources/product/dist/packages/diagnostics/src/outbox.js',
    ...[...REQUIRED_FRONTEND_FILES, ...REQUIRED_MANAGED_LUAU_FILES].map(file => 'resources/product/' + file)]) {
    if (!seen.has(path.toLowerCase())) throw new Error('Missing required Windows bundle file: ' + path);
  }
  if (!manifest.files.some(file => file.path.startsWith('locales/'))) throw new Error('Missing Electron locales.');
  for (const forbidden of ['resources/default_app.asar', 'resources/app.asar', 'electron.exe']) {
    if (seen.has(forbidden.toLowerCase())) throw new Error('Unexpected Electron application entry: ' + forbidden);
  }
  windowsX64Exe(await regularBytes(join(directory, 'Arcane.exe')), 'Arcane.exe');
  windowsX64Exe(await regularBytes(join(directory, 'resources/node/node.exe')), 'Node');
  validateNodeLicense(await regularBytes(join(directory, 'resources/node/LICENSE')));
  if ((await regularBytes(join(directory, 'version'))).toString('utf8').trim() !== manifest.electron.version ||
      JSON.stringify(await json(join(directory, 'resources/app/package.json'))) !== JSON.stringify(appPackage(manifest.version))) {
    throw new Error('Electron version/application entry mismatch.');
  }
  const product = join(directory, 'resources/product');
  const releaseProof = await verifyLocalRelease(product);
  if (releaseProof.manifestSha256 !== manifest.sourceRelease?.manifestSha256) throw new Error('Product snapshot manifest mismatch.');
  const originalManifestBytes = await regularBytes(join(directory, 'resources/source-manifest.json'));
  if (hash(originalManifestBytes) !== manifest.sourceRelease.originalManifestSha256 || manifest.sourceRelease.testPayloadsIncluded !== false) throw new Error('Original source manifest provenance mismatch.');
  const originalManifest = JSON.parse(originalManifestBytes.toString('utf8'));
  if (originalManifest.schemaVersion !== 1 || originalManifest.kind !== 'arcane-local-source-release' || !Array.isArray(originalManifest.files) || originalManifest.fileCount !== originalManifest.files.length || originalManifest.files.length > 4096) throw new Error('Invalid original source manifest.');
  const derived = deploymentManifest(originalManifest);
  if (JSON.stringify(await json(join(product, 'release-manifest.json'))) !== JSON.stringify(derived)) throw new Error('Deployment must be an exact test-free projection of the original source manifest.');
  const pkg = await json(join(product, 'package.json')), lock = await json(join(product, 'package-lock.json'));
  if (pkg.version !== manifest.version || pkg.devDependencies?.electron !== manifest.electron.version ||
      lock.packages?.['node_modules/electron']?.version !== manifest.electron.version) throw new Error('Product/Electron version mismatch.');
  const dependencies = await productionDependencies(product, pkg, lock);
  if (JSON.stringify(dependencies) !== JSON.stringify(manifest.dependencies)) throw new Error('Production dependency inventory mismatch.');
  const release = await json(join(product, 'release-manifest.json'));
  for (const file of [...HOST_FILES, ...(seen.has('resources/app/icon.png') ? ['icon.png'] : [])]) {
    const source = release.files.find(entry => entry.path === 'apps/desktop/electron/' + file);
    if (!source || hash(await regularBytes(join(directory, 'resources/app/' + file))) !== source.sha256) {
      throw new Error('Host differs from the verified product snapshot: ' + file);
    }
  }
  const productFiles = new Set([...release.files.map(file => 'resources/product/' + file.path), 'resources/product/release-manifest.json']);
  for (const file of manifest.files) {
    const path = file.path;
    if (path.startsWith('resources/product/node_modules/')) {
      if (!dependencies.some(dep => path.startsWith('resources/product/' + dep.path + '/') &&
          !path.slice(('resources/product/' + dep.path + '/').length).split('/').some(part =>
            part.startsWith('.') || DEPENDENCY_OMISSIONS.has(part.toLowerCase())))) throw new Error('Unselected production dependency payload.');
    } else if (path.startsWith('resources/product/')) {
      if (!productFiles.has(path)) throw new Error('Unlisted product snapshot payload.');
    } else if (path.startsWith('resources/app/')) {
      if (!['package.json', ...HOST_FILES, 'icon.png'].includes(path.slice('resources/app/'.length))) throw new Error('Unexpected host payload.');
    } else if (path.startsWith('resources/node/')) {
      if (!['resources/node/node.exe', 'resources/node/LICENSE'].includes(path)) throw new Error('Unexpected Node payload.');
    } else if (path === 'resources/source-manifest.json') { /* Its full hash and deployment projection were verified above. */
    } else if (!electronPath(path === 'Arcane.exe' ? 'electron.exe' : path)) throw new Error('Unexpected Electron payload.');
  }
  return { files: seen.size, bytes: totalBytes, manifestSha256: hash(manifestBytes), integrityOnly: true,
    signed: false, installer: false, installedNodeRequired: false, applicationLaunchVerified: false,
    electronVersion: manifest.electron.version, nodeVersion: manifest.node.version };
}

// CLI diagnostics use the caller-owned stderr descriptor. No path/authority is
// accepted from a progress record, and each write finishes before it resolves.
function cliProgress(record) {
  const line = Buffer.from(JSON.stringify(record) + '\n');
  return new Promise((accept, reject) => {
    writeDiagnostic(2, line, 0, line.length, null, (error, written) => {
      if (error) reject(error);
      else if (written !== line.length) reject(new Error('Package progress write was incomplete.'));
      else accept();
    });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--verify' && isAbsolute(args[1])) {
    console.log(JSON.stringify(await verifyWindowsBundle(args[1]), null, 2));
  } else if (!args.length || (args.length === 2 && args[0] === '--node-license' && isAbsolute(args[1]))) {
    console.log(JSON.stringify(await packageWindows({ nodeLicense: args[1], onProgress: cliProgress }), null, 2));
  } else throw new Error('Usage: node scripts/package-windows.mjs [--node-license ABSOLUTE_LICENSE_FILE | --verify ABSOLUTE_BUNDLE_DIRECTORY]');
}

