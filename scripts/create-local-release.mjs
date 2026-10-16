import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat, realpath, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANAGED_LUAU_FILES, REQUIRED_MANAGED_LUAU_FILES, validateManagedLuauFiles, verifyManagedLuauCompiler } from './managed-luau-compiler.mjs';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'README.md'];
const SOURCE_ROOTS = ['apps', 'packages', 'workers', 'plugin', 'scripts', 'skills', 'docs', 'tests', 'dist', '.github', 'installer'];
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'runtime', '.runtime', '.tmp', '.git', '.codex', '.agents', 'generated', '__pycache__', '.worker', 'cache']);
const EXTENSIONS = /\.(?:ts|js|mjs|cjs|cs|json|map|html|css|md|csv|py|luau|lua|rbxm|rbxmx|yml|yaml|txt)$/;
export const BRAND_BITMAP_PATH = 'apps/desktop/public/brand/arcane-ridges.png';
export const REQUIRED_FRONTEND_FILES = [
  'apps/desktop/public/studio.html', 'apps/desktop/public/studio.css',
  'dist/apps/desktop/src/studio.js', 'dist/apps/desktop/src/codex-chat.js',
  'apps/desktop/src/codex-task-plan.ts', 'dist/apps/desktop/src/codex-task-plan.js', 'dist/apps/desktop/src/codex-task-plan.js.map',
  'apps/desktop/src/task-plan-boot.ts', 'dist/apps/desktop/src/task-plan-boot.js', 'dist/apps/desktop/src/task-plan-boot.js.map',
  'apps/desktop/src/chat-tabs.ts', 'dist/apps/desktop/src/chat-tabs.js', 'dist/apps/desktop/src/chat-tabs.js.map',
  'apps/desktop/src/chat-attachments.ts', 'dist/apps/desktop/src/chat-attachments.js', 'dist/apps/desktop/src/chat-attachments.js.map',
  'apps/desktop/src/task-usage.ts', 'dist/apps/desktop/src/task-usage.js', 'dist/apps/desktop/src/task-usage.js.map',
  'apps/desktop/src/task-usage-ui.ts', 'dist/apps/desktop/src/task-usage-ui.js', 'dist/apps/desktop/src/task-usage-ui.js.map',
  'apps/desktop/src/desktop-verification.ts', 'dist/apps/desktop/src/desktop-verification.js',
  'dist/apps/desktop/src/desktop-verification.js.map',
  'apps/desktop/src/provider-setup.ts', 'dist/apps/desktop/src/provider-setup.js','dist/apps/desktop/src/provider-setup.js.map',
  'apps/desktop/src/native-handoff.ts', 'dist/apps/desktop/src/native-handoff.js', 'dist/apps/desktop/src/native-handoff.js.map',
  'apps/desktop/src/studio-key-settings.ts', 'dist/apps/desktop/src/studio-key-settings.js', 'dist/apps/desktop/src/studio-key-settings.js.map',
  'apps/desktop/src/workspace-shell.ts', 'dist/apps/desktop/src/workspace-shell.js',
  'dist/apps/desktop/src/workspace-shell.js.map', 'apps/desktop/src/asset-downloads.ts',
  'dist/apps/desktop/src/asset-downloads.js', 'dist/apps/desktop/src/asset-downloads.js.map',
  'apps/desktop/src/asset-viewer.ts', 'dist/apps/desktop/src/asset-viewer.js', 'dist/apps/desktop/src/asset-viewer.js.map',
  'apps/desktop/src/automatic-asset-previews.ts', 'dist/apps/desktop/src/automatic-asset-previews.js', 'dist/apps/desktop/src/automatic-asset-previews.js.map',
  'apps/desktop/src/playtest-panel.ts', 'dist/apps/desktop/src/playtest-panel.js', 'dist/apps/desktop/src/playtest-panel.js.map',
  'apps/desktop/src/glb-preflight.ts', 'dist/apps/desktop/src/glb-preflight.js', 'dist/apps/desktop/src/glb-preflight.js.map',
  'apps/desktop/public/asset-viewer-runtime.mjs', 'apps/desktop/public/vendor/three/manifest.json', 'apps/desktop/public/vendor/three/LICENSE',
  ...['build/three.module.js', 'build/three.core.js', 'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/controls/OrbitControls.js', 'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/SkeletonUtils.js'].map(path => 'apps/desktop/public/vendor/three/' + path),
  'apps/desktop/src/learning-panel.ts', 'dist/apps/desktop/src/learning-panel.js', 'dist/apps/desktop/src/learning-panel.js.map', 'apps/desktop/src/codex-history.ts','apps/desktop/src/workflow-panel.ts', 'dist/apps/desktop/src/codex-history.js','dist/apps/desktop/src/workflow-panel.js', 'dist/apps/desktop/src/codex-history.js.map','dist/apps/desktop/src/workflow-panel.js.map', BRAND_BITMAP_PATH,
];
const CONTROLLED_FILES = new Set([BRAND_BITMAP_PATH, 'apps/desktop/electron/icon.png', 'apps/desktop/electron/icon.ico', 'scripts/setup-arcane.ps1', 'scripts/launch-arcane.cmd', 'installer/setup.manifest', 'installer/launcher.manifest', 'installer/uninstaller.manifest', 'apps/desktop/public/vendor/three/LICENSE', ...MANAGED_LUAU_FILES]);
const FIRST_RUN_FILES = ['scripts/setup-arcane.ps1', 'scripts/launch-arcane.cmd', 'docs/build/FIRST_RUN.md'];
const allowedFile = path => EXTENSIONS.test(path) || CONTROLLED_FILES.has(path);
export function validateBrandBitmap(bytes) {
  if (bytes.length <= 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG signature in ' + BRAND_BITMAP_PATH + '.');
}
const FORBIDDEN_NAMES = /^(?:\.env(?:\..*)?|auth\.json|credentials\.json|daemon\.json|preferences\.json|.*\.log|.*\.key|.*\.pem|.*\.partial)$/i;
const MUTABLE_ROOTS = ['node_modules', 'runtime', 'apps/mcp/generated'];
const MAX_FILES = 4096, MAX_FILE_BYTES = 32 * 1024 * 1024, MAX_BYTES = 128 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function inside(root, target) {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}
function validPath(path) {
  if (typeof path !== 'string' || path.length > 512 || !/^[A-Za-z0-9_.\-/]+$/.test(path)) throw new Error('Invalid release path.');
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || FORBIDDEN_NAMES.test(segment) || EXCLUDED_DIRECTORIES.has(segment))) throw new Error('Forbidden release path.');
  if (!(ROOT_FILES.includes(path) || SOURCE_ROOTS.includes(segments[0])) || (!ROOT_FILES.includes(path) && !allowedFile(path))) throw new Error('File is outside the release allowlist.');
  return path;
}
async function noLinks(path) {
  let current = resolve(path);
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Release paths cannot contain symlinks or junctions.');
      const actual = await realpath(current);
      const same = process.platform === 'win32' ? actual.toLowerCase() === current.toLowerCase() : actual === current;
      if (!same) throw new Error('Release path resolves to a different location.');
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
async function regularBytes(path) {
  await noLinks(path);
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) throw new Error('Expected a bounded single-link release file.');
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('Release source changed while reading. Try again after writers finish.');
  return bytes;
}
function secretCheck(bytes, name) {
  if (name === BRAND_BITMAP_PATH) validateBrandBitmap(bytes);
  // This is defense-in-depth, not a claim that a regex can identify every secret.
  // Session/provider storage is excluded structurally, irrespective of contents.
  const text = bytes.toString('utf8');
  if (/arcane_local_v1_\d+_[a-f0-9]{64}\b/.test(text) || /http:\/\/127\.0\.0\.1:\d+\/(?:studio)?#[a-f0-9]{64}\b/.test(text)) throw new Error('An actual local credential/session link appears in ' + name + '.');
  if (name.endsWith('.json')) {
    let value; try { value = JSON.parse(text); } catch { throw new Error('Invalid JSON in release source ' + name + '.'); }
    const visit = (node, depth = 0) => {
      if (depth > 64) throw new Error('Overdeep JSON in release source.');
      if (!node || typeof node !== 'object') return;
      for (const [key, item] of Object.entries(node)) {
        if (/^(?:access_token|refresh_token|client_secret|password|authorization|apiKey|token)$/i.test(key) && typeof item === 'string' && item.length > 0) throw new Error('Credential-like JSON field in ' + name + '.');
        visit(item, depth + 1);
      }
    }; visit(value);
  }
}
async function collect(repository) {
  const files = []; let totalBytes = 0;
  async function add(path) {
    validPath(path);
    const bytes = await regularBytes(join(repository, ...path.split('/'))); secretCheck(bytes, path);
    totalBytes += bytes.length;
    if (files.length >= MAX_FILES || totalBytes > MAX_BYTES) throw new Error('Release exceeds the packaging budget.');
    files.push({ path, bytes, sha256: hash(bytes) });
  }
  async function walk(path) {
    await noLinks(join(repository, path));
    const entries = (await readdir(join(repository, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORIES.has(entry.name) || FORBIDDEN_NAMES.test(entry.name) || entry.name.startsWith('.')) continue;
      const child = path + '/' + entry.name;
      // Windows directory entries can misclassify OneDrive cloud placeholders.
      // lstat + canonical path checks remain authoritative; genuine links fail.
      const kind = await lstat(join(repository, child));
      if (kind.isSymbolicLink()) throw new Error('Link in release input: ' + child);
      if (kind.isDirectory()) await walk(child);
      else if (kind.isFile() && allowedFile(child)) await add(child);
      else if (!kind.isFile()) throw new Error('Special file in release input.');
    }
  }
  for (const path of ROOT_FILES) await add(path);
  for (const root of SOURCE_ROOTS) {
    // Older source fixtures predate the installer; when present its reviewed source
    // belongs to the release closure alongside the build scripts and component tests.
    if (root === 'installer') { try { await lstat(join(repository, root)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; } }
    await walk(root);
  }
  return { files, totalBytes };
}
function validateCompiledSources(files) {
  const sources = new Map(files.map(file => [file.path, file]));
  const covered = new Set();
  for (const file of files.filter(file => file.path.startsWith('dist/') && file.path.endsWith('.js.map'))) {
    const map = JSON.parse(file.bytes.toString('utf8'));
    if (map.version !== 3 || (map.sourceRoot && map.sourceRoot !== '') || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent) || map.sources.length !== map.sourcesContent.length) throw new Error('Rebuild with inlineSources: missing compiled source provenance in ' + file.path);
    for (let index = 0; index < map.sources.length; index++) {
      const source = map.sources[index];
      if (typeof source !== 'string' || isAbsolute(source)) throw new Error('Invalid compiled source provenance path.');
      const path = relative('/', resolve('/', dirname(file.path), source)).split(sep).join('/');
      const original = sources.get(path);
      if (!original || typeof map.sourcesContent[index] !== 'string' || map.sourcesContent[index].replace(/^\uFEFF/, '') !== original.bytes.toString('utf8').replace(/^\uFEFF/, '')) throw new Error('Compiled source is stale/missing: ' + path);
      covered.add(path);
    }
  }
  for (const file of files) {
    if (/^(?:apps\/(?:daemon|desktop|mcp)\/src\/.*|packages\/.*|tests\/unit\/.*)\.ts$/.test(file.path) && !file.path.endsWith('.d.ts') && !covered.has(file.path)) throw new Error('Source has no current compiled map: ' + file.path);
  }
}
function validateWorkspaceLock(files) {
  const parse = path => JSON.parse(files.find(file => file.path === path).bytes.toString('utf8'));
  const pkg = parse('package.json'), lock = parse('package-lock.json');
  if (lock.lockfileVersion !== 3 || !lock.packages || !lock.packages['']) throw new Error('Expected an npm v3 package lock.');
  const root = lock.packages[''];
  for (const category of ['dependencies', 'devDependencies']) {
    const expected = Object.entries(pkg[category] ?? {}).sort();
    const recorded = Object.entries(root[category] ?? {}).sort();
    if (JSON.stringify(expected) !== JSON.stringify(recorded)) throw new Error('Root package dependencies are out of sync with package-lock.json.');
  }
  const workspaces = pkg.workspaces ?? [];
  if (!Array.isArray(workspaces) || workspaces.some(pattern => !['apps/*', 'packages/*'].includes(pattern))) throw new Error('Unsupported release workspace pattern.');
  for (const file of files) {
    if (!/^(apps|packages)\/[^/]+\/package.json$/.test(file.path) || !workspaces.includes(file.path.split('/')[0] + '/*')) continue;
    const workspace = JSON.parse(file.bytes.toString('utf8'));
    const path = file.path.slice(0, -'/package.json'.length), entry = lock.packages[path];
    const linked = lock.packages['node_modules/' + workspace.name];
    if (!entry || entry.name !== workspace.name || entry.version !== workspace.version || !linked || linked.link !== true || linked.resolved !== path) throw new Error('Workspace is missing/stale in package-lock.json: ' + path);
  }
}
function validateInstallerSources(files) {
  if (files.some(file => file.path === 'tests/release/windows-directory-pins.test.mjs')) {
    for (const name of ['OwnedFiles.cs', 'StageDirectory.cs', 'ReleaseRemoval.cs', 'InstalledRecord.cs', 'PayloadArchive.cs', 'InstallationActivity.cs', 'SetupPath.cs', 'OperationLease.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Directory pin verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => ['tests/release/windows-installer-payload.test.mjs', 'tests/release/windows-setup-payload.test.mjs'].includes(file.path)) && !files.some(file => file.path === 'installer/PayloadArchive.cs')) {
    throw new Error('Installer payload verification requires its matching C# source.');
  }
  if (files.some(file => file.path === 'tests/release/windows-installer-kit.test.mjs') && !files.some(file => file.path === 'installer/KitVerifier.cs')) {
    throw new Error('Installer kit verification requires its matching C# source.');
  }
  if (files.some(file => file.path === 'tests/release/windows-installed-launcher.test.mjs')) {
    for (const name of ['InstalledRecord.cs', 'OperationLease.cs', 'Launcher.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Installed launcher verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-setup-owned-files.test.mjs')) {
    for (const name of ['OwnedFiles.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Setup file verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-setup-ownership.test.mjs')) {
    for (const name of ['SetupOwnership.cs', 'OwnedFiles.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Setup ownership verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-shell-link.test.mjs')) {
    for (const name of ['ShellLink.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Shortcut verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-post-install.test.mjs')) {
    for (const name of ['PostInstall.cs', 'ShellLink.cs', 'Registration.cs', 'RegistrationPlan.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'Launcher.cs', 'InstallProcess.cs', 'KitVerifier.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Postinstall verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-setup-root-files.test.mjs')) {
    for (const name of ['PostInstall.cs', 'ShellLink.cs', 'Registration.cs', 'RegistrationPlan.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'Launcher.cs', 'InstallProcess.cs', 'KitVerifier.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Setup root file verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-setup-path.test.mjs')) {
    for (const name of ['SetupPath.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Setup path verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-installation-activity.test.mjs')) {
    for (const name of ['InstallationActivity.cs', 'SetupPath.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Installation activity verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-registration-store.test.mjs')) {
    for (const name of ["Registration.cs","RegistrationPlan.cs","SetupOwnership.cs","OwnedFiles.cs","InstalledRecord.cs","OperationLease.cs","PayloadArchive.cs"]) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Registration store verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-registration-lifecycle.test.mjs')) {
    for (const name of ["SetupForm.cs","PayloadArchive.cs","KitVerifier.cs","InstallProcess.cs","StageDirectory.cs","InstalledRecord.cs","OperationLease.cs","Launcher.cs","OwnedFiles.cs","SetupOwnership.cs","PostInstall.cs","ShellLink.cs","SetupPath.cs","UninstallEntry.cs","UninstallHandoff.cs","UninstallStage.cs","UninstallForm.cs","UninstallTransaction.cs","UninstallConsent.cs","ReleaseRemoval.cs","InstallationActivity.cs","Registration.cs","RegistrationPlan.cs"]) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Registration lifecycle verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-registration-plan.test.mjs')) {
    for (const name of ['RegistrationPlan.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Registration plan verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-operation-lease.test.mjs')) {
    for (const name of ['OperationLease.cs', 'InstalledRecord.cs', 'Launcher.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Operation lease verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-setup-form.test.mjs')) {
    for (const name of ['SetupForm.cs', 'PayloadArchive.cs', 'KitVerifier.cs', 'InstallProcess.cs', 'StageDirectory.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'Launcher.cs', 'OwnedFiles.cs', 'SetupOwnership.cs', 'PostInstall.cs', 'ShellLink.cs', 'Registration.cs', 'RegistrationPlan.cs', 'SetupPath.cs', 'UninstallEntry.cs', 'UninstallHandoff.cs', 'UninstallStage.cs', 'UninstallForm.cs', 'UninstallTransaction.cs', 'UninstallConsent.cs', 'ReleaseRemoval.cs', 'InstallationActivity.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Setup form verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-release-removal.test.mjs')) {
    for (const name of ['ReleaseRemoval.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs', 'InstallationActivity.cs', 'SetupPath.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Release removal verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-uninstall-consent.test.mjs')) {
    for (const name of ['UninstallConsent.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Uninstall consent verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-uninstall-transaction.test.mjs')) {
    for (const name of ['Registration.cs', 'RegistrationPlan.cs', 'UninstallTransaction.cs', 'ShellLink.cs', 'UninstallConsent.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'ReleaseRemoval.cs', 'InstallationActivity.cs', 'SetupPath.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Uninstall transaction verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-uninstall-form.test.mjs')) {
    for (const name of ['Registration.cs', 'RegistrationPlan.cs', 'UninstallForm.cs', 'UninstallTransaction.cs', 'UninstallConsent.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'ReleaseRemoval.cs', 'InstallationActivity.cs', 'SetupPath.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Uninstall form verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-uninstall-stage.test.mjs')) {
    for (const name of ['UninstallStage.cs', 'StageDirectory.cs', 'OwnedFiles.cs', 'SetupOwnership.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Uninstall staging verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'tests/release/windows-uninstall-handoff.test.mjs')) {
    for (const name of ['Registration.cs', 'RegistrationPlan.cs', 'UninstallEntry.cs', 'UninstallHandoff.cs', 'UninstallStage.cs', 'UninstallForm.cs', 'UninstallTransaction.cs', 'UninstallConsent.cs', 'ReleaseRemoval.cs', 'InstallationActivity.cs', 'SetupPath.cs', 'StageDirectory.cs', 'OwnedFiles.cs', 'SetupOwnership.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Uninstall handoff verification requires its matching C# source: ' + name);
    }
  }
  if (files.some(file => file.path === 'scripts/build-windows-setup.mjs')) {
    for (const name of ['PayloadArchive.cs', 'KitVerifier.cs', 'InstallProcess.cs', 'StageDirectory.cs', 'SetupForm.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'Launcher.cs', 'OwnedFiles.cs', 'SetupOwnership.cs', 'PostInstall.cs', 'SetupPath.cs', 'UninstallEntry.cs', 'UninstallHandoff.cs', 'UninstallStage.cs', 'UninstallForm.cs', 'UninstallTransaction.cs', 'UninstallConsent.cs', 'ReleaseRemoval.cs', 'InstallationActivity.cs', 'setup.manifest', 'launcher.manifest', 'uninstaller.manifest']) {
      if (!files.some(file => file.path === 'installer/' + name)) throw new Error('Setup builder requires its complete native source: ' + name);
    }
  }
}
export async function createLocalRelease({ repository = REPOSITORY } = {}) {
  repository = resolve(repository); await noLinks(repository); repository = await realpath(repository);
  const { files, totalBytes } = await collect(repository);
  validateInstallerSources(files);
  validateWorkspaceLock(files);
  const packageJson = JSON.parse(files.find(file => file.path === 'package.json').bytes.toString('utf8'));
  const firstRunDeclared = packageJson.scripts?.['setup:arcane'] !== undefined || files.some(file => FIRST_RUN_FILES.includes(file.path));
  if (files.some(file => file.path === 'plugin/build/ArcaneLocalBridge.lua')) throw new Error('Rebuild the modular plugin before packaging; stale single-script artifact remains.');
  for (const required of ['dist/apps/daemon/src/product-main.js', 'dist/apps/mcp/src/main.js', 'plugin/build/ArcaneLocalBridge.rbxmx', 'plugin/build/manifest.json', ...REQUIRED_FRONTEND_FILES, ...REQUIRED_MANAGED_LUAU_FILES, ...(firstRunDeclared ? FIRST_RUN_FILES : [])]) {
    if (!files.some(file => file.path === required)) throw new Error('Build the product and plugin before packaging: missing ' + required);
  }
  validateCompiledSources(files);
  validateManagedLuauFiles(files);
  verifyManagedLuauCompiler(repository);
  const outputRoot = join(repository, 'runtime', 'releases');
  if (!inside(repository, outputRoot)) throw new Error('Release output escapes the repository.');
  await noLinks(outputRoot); await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(join(outputRoot, 'arcane-local-'));
  await noLinks(directory);
  for (const file of files) {
    const target = join(directory, ...file.path.split('/'));
    if (!inside(directory, target)) throw new Error('Release target escapes output.');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { flag: 'wx' });
  }
  // No credentials, provider caches, node_modules, or user data are copied.
  const manifest = { schemaVersion: 1, kind: 'arcane-local-source-release', createdAt: new Date().toISOString(),
    version: JSON.parse((files.find(file => file.path === 'package.json')).bytes.toString('utf8')).version,
    runtime: { nodeMajorMinimum: 24, dependenciesIncluded: false, inferenceStarted: false, installed: false, fullProductVerified: false },
    fileCount: files.length, totalBytes, files: files.map(({ path, bytes, sha256 }) => ({ path, bytes: bytes.length, sha256 })) };
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  for (const file of files) {
    if (hash(await regularBytes(join(repository, ...file.path.split('/')))) !== file.sha256) throw new Error('Release source changed during packaging; incomplete output retained for diagnosis.');
  }
  const proof = await verifyLocalRelease(directory);
  return { directory, manifestSha256: proof.manifestSha256, files: proof.files, bytes: proof.bytes,
    dependencyInstallRequired: true, fullProductVerified: false };
}
export async function verifyLocalRelease(directory) {
  directory = resolve(directory); await noLinks(directory); directory = await realpath(directory);
  const manifestBytes = await regularBytes(join(directory, 'release-manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'arcane-local-source-release' || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES || manifest.fileCount !== manifest.files.length) throw new Error('Invalid release manifest.');
  const seen = new Set(), verifiedFiles = []; let totalBytes = 0;
  validateInstallerSources(manifest.files);
  for (const entry of manifest.files) {
    const path = validPath(entry.path);
    if (seen.has(path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid release file descriptor.');
    seen.add(path);
    const target = join(directory, ...path.split('/')); if (!inside(directory, target)) throw new Error('Release path escapes package.');
    const bytes = await regularBytes(target); secretCheck(bytes, path);
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error('Release checksum mismatch: ' + path);
    verifiedFiles.push({ path, bytes });
    totalBytes += bytes.length;
    if (totalBytes > MAX_BYTES) throw new Error('Release exceeds verification budget.');
  }
  // Reject unlisted payloads, even if all listed hashes still match.
  async function inventory(path = '') {
    for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
      const child = path ? path + '/' + entry.name : entry.name;
      if (MUTABLE_ROOTS.includes(child)) continue; // Dependency/user state is explicitly outside the integrity proof.
      const kind = await lstat(join(directory, child));
      if (kind.isSymbolicLink()) throw new Error('Link in release output.');
      if (kind.isDirectory()) { await noLinks(join(directory, child)); await inventory(child); }
      else if (!kind.isFile() || (child !== 'release-manifest.json' && !seen.has(child))) throw new Error('Unlisted file in release output: ' + child);
    }
  }
  await inventory();
  validateManagedLuauFiles(verifiedFiles);
  if (manifest.totalBytes !== totalBytes) throw new Error('Release byte count mismatch.');
  return { files: seen.size, bytes: totalBytes, manifestSha256: hash(manifestBytes),
    integrityOnly: true, signed: false, runtimeVerified: false, mutableRootsNotVerified: MUTABLE_ROOTS };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length) console.log(JSON.stringify(await createLocalRelease(), null, 2));
  else if (args.length === 2 && args[0] === '--verify' && isAbsolute(args[1])) console.log(JSON.stringify(await verifyLocalRelease(args[1]), null, 2));
  else throw new Error('Usage: node scripts/create-local-release.mjs [--verify ABSOLUTE_RELEASE_DIRECTORY]');
}
