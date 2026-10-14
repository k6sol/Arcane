import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reviewed first-party pins. Neither manifests, environment variables nor callers
// can select a different binary. Updating these requires a deliberate release review.
export const MANAGED_LUAU_DIRECTORY = 'apps/desktop/host-tools/luau';
export const MANAGED_LUAU_SHA256 = '74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8';
export const MANAGED_LUAU_BYTES = 1403904;
export const MANAGED_LUAU_EVIDENCE_DIRECTORY = 'arcane-evidence/luau';
export const MANAGED_LUAU_MANIFEST = Object.freeze({
  schemaVersion: 1,
  kind: 'arcane-managed-luau-compiler',
  version: '0.742',
  platform: 'win32',
  arch: 'x64',
  repository: 'https://github.com/luau-lang/luau',
  release: 'https://github.com/luau-lang/luau/releases/tag/0.742',
  commit: '8387cfb461b38ce09e37c1e4c2811538ef1bf5cb',
  archive: Object.freeze({
    url: 'https://github.com/luau-lang/luau/releases/download/0.742/luau-windows.zip',
    metadata: 'https://api.github.com/repos/luau-lang/luau/releases/tags/0.742',
    publishedDigest: 'https://github.com/luau-lang/luau/releases/expanded_assets/0.742',
    assetId: 626558808,
    bytes: 3190105,
    sha256: '1114966cd8198f407069f07e8b4e6bacf2ded933e4a57d6ddc75617969278c75',
    member: 'luau-compile.exe',
    verification: 'Existing local archive matches the official immutable release asset digest; its compiler member matches the compiler pin.',
  }),
  compiler: Object.freeze({ file: 'luau-compile.exe', bytes: MANAGED_LUAU_BYTES, sha256: MANAGED_LUAU_SHA256 }),
  license: Object.freeze({
    file: 'LICENSE', spdx: 'MIT',
    source: 'https://raw.githubusercontent.com/luau-lang/luau/0.742/LICENSE.txt',
    bytes: 1124,
    sha256: 'c7c6f287cc2594eec205aac1a5561d2a9d12c375483aff6b32f379da99544f84',
  }),
});
export const MANAGED_LUAU_FILES = Object.freeze(['luau-compile.exe', 'LICENSE', 'manifest.json'].map(name => MANAGED_LUAU_DIRECTORY + '/' + name));
export const REQUIRED_MANAGED_LUAU_FILES = Object.freeze(['scripts/managed-luau-compiler.mjs', ...MANAGED_LUAU_FILES]);
const manifestBytes = () => Buffer.from(JSON.stringify(MANAGED_LUAU_MANIFEST, null, 2) + '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = () => { throw new Error('Managed Luau compiler is unavailable.'); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameNode = (a, b) => ['dev', 'ino', 'mode', 'nlink'].every(key => a[key] === b[key]);
const sameFile = (a, b) => sameNode(a, b) && ['size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

export function validateManagedLuauExecutable(bytes) {
  // Check native identity as well as byte identity; source text/padding is never executable evidence.
  if (!Buffer.isBuffer(bytes) || bytes.length !== MANAGED_LUAU_BYTES || bytes.toString('ascii', 0, 2) !== 'MZ') unavailable();
  const offset = bytes.readUInt32LE(0x3c);
  if (offset < 64 || offset + 26 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550 ||
      bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 24) !== 0x20b ||
      !(bytes.readUInt16LE(offset + 22) & 2) || (bytes.readUInt16LE(offset + 22) & 0x2000) ||
      hash(bytes) !== MANAGED_LUAU_SHA256) unavailable();
}

/** Validate actual inventory bytes, never trust a digest supplied by an inventory. */
export function validateManagedLuauFiles(files) {
  const selected = files.filter(file => file.path.toLowerCase().startsWith(MANAGED_LUAU_DIRECTORY.toLowerCase() + '/'));
  if (selected.length !== MANAGED_LUAU_FILES.length || REQUIRED_MANAGED_LUAU_FILES.some(path => !files.some(file => file.path === path))) unavailable();
  for (const path of MANAGED_LUAU_FILES) if (selected.filter(file => file.path === path).length !== 1) unavailable();
  const bytes = name => selected.find(file => file.path === MANAGED_LUAU_DIRECTORY + '/' + name).bytes;
  validateManagedLuauExecutable(bytes('luau-compile.exe'));
  const license = bytes('LICENSE');
  if (!Buffer.isBuffer(license) || license.length !== MANAGED_LUAU_MANIFEST.license.bytes || hash(license) !== MANAGED_LUAU_MANIFEST.license.sha256 ||
      !Buffer.isBuffer(bytes('manifest.json')) || !bytes('manifest.json').equals(manifestBytes())) unavailable();
}

function directChain(full, kind = 'directory', missing = false) {
  if (!isAbsolute(full) || resolve(full) !== full || /^(?:\\\\|\/\/)/.test(full)) unavailable();
  const chain = [];
  for (let current = full; ; current = dirname(current)) {
    try {
      const stat = fs.lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink() || !samePath(fs.realpathSync(current), current) ||
          (current === full && kind === 'file' ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) unavailable();
      chain.push({ path: current, stat });
    } catch (error) { if (!missing || error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
  return chain;
}
function checkChain(chain) {
  for (const node of chain) {
    const after = fs.lstatSync(node.path, { bigint: true });
    if (!sameNode(node.stat, after) || after.isSymbolicLink() || !samePath(fs.realpathSync(node.path), node.path) ||
        (node.stat.isFile() ? !after.isFile() || after.nlink !== 1n : !after.isDirectory())) unavailable();
  }
}
function pinnedBytes(full, limit) {
  const chain = directChain(full, 'file'), initial = chain[0].stat;
  if (initial.size > BigInt(limit)) unavailable();
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(initial, fs.fstatSync(fd, { bigint: true }))) unavailable();
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length - length) unavailable();
      if (!count) break;
      length += count;
    }
    checkChain(chain);
    if (!sameFile(initial, fs.fstatSync(fd, { bigint: true })) || !sameFile(initial, fs.lstatSync(full, { bigint: true })) || BigInt(length) !== initial.size) unavailable();
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

/** Fixed product-root layout in a checkout and resources/product in a Windows bundle. No downloads or execution. */
export function verifyManagedLuauCompiler(productRoot) {
  directChain(productRoot);
  const directory = join(productRoot, MANAGED_LUAU_DIRECTORY), chain = directChain(directory);
  const inventory = () => {
    if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(['LICENSE', 'luau-compile.exe', 'manifest.json'].sort())) unavailable();
  };
  inventory();
  const files = MANAGED_LUAU_FILES.map(path => ({ path, bytes: pinnedBytes(join(productRoot, path), path.endsWith('.exe') ? MANAGED_LUAU_BYTES : 8192) }));
  files.push({ path: 'scripts/managed-luau-compiler.mjs', bytes: pinnedBytes(join(productRoot, 'scripts/managed-luau-compiler.mjs'), 32768) });
  validateManagedLuauFiles(files); checkChain(chain); inventory();
  return Object.freeze({ executablePath: join(productRoot, MANAGED_LUAU_FILES[0]), sha256: MANAGED_LUAU_SHA256 });
}

/** Called only by the trusted desktop bootstrap. Saved settings remain authoritative. */
export function managedCodeVerificationConfiguration({ codeVerification, project, productRoot }) {
  const saved = codeVerification.daemonConfiguration(project);
  const absent = value => value.failure === null && value.settingsHash === null && Object.keys(value.environment).length === 0;
  if (!absent(saved) || process.platform !== 'win32') return saved;
  try {
    // Finish directory preparation before the adapter pins directories. Do not
    // put evidence in private project-state/runtime storage or alter its ACLs.
    const projectChain = directChain(project.projectPath);
    for (const path of ['arcane-evidence', MANAGED_LUAU_EVIDENCE_DIRECTORY]) {
      const full = join(project.projectPath, path);
      directChain(full, 'directory', true);
      try { fs.mkdirSync(full, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      directChain(full); checkChain(projectChain);
    }
    const compiler = verifyManagedLuauCompiler(productRoot);
    const current = codeVerification.daemonConfiguration(project);
    if (!absent(current)) return current;
    directChain(join(project.projectPath, MANAGED_LUAU_EVIDENCE_DIRECTORY)); checkChain(projectChain);
    return { environment: { ARCANE_LUAU_COMPILER_PATH: compiler.executablePath, ARCANE_LUAU_COMPILER_SHA256: compiler.sha256,
      ARCANE_LUAU_EVIDENCE_DIRECTORY: MANAGED_LUAU_EVIDENCE_DIRECTORY }, settingsHash: null, failure: null };
  } catch {
    // Trusted settings faults still fail closed. An unavailable managed binary
    // is never downloaded, replaced, searched for or exempted from antivirus.
    const current = codeVerification.daemonConfiguration(project);
    return absent(current) ? { environment: {}, settingsHash: null, failure: 'compiler-unavailable' } : current;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/managed-luau-compiler.mjs');
  console.log(JSON.stringify(verifyManagedLuauCompiler(resolve(dirname(fileURLToPath(import.meta.url)), '..')), null, 2));
}
