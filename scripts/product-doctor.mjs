import { readFile, lstat, readdir, stat, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute, sep, basename, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BRAND_BITMAP_PATH, REQUIRED_FRONTEND_FILES, validateBrandBitmap } from './create-local-release.mjs';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/**
 * Launch preflight used by start-product/open-project/check-local-release: files and dependencies only,
 * no child processes. `npm run doctor` adds the environment checks in runDoctor() below.
 */
export async function productDoctor({ repository = REPOSITORY, nodeVersion = process.versions.node } = {}) {
  repository = resolve(repository); const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  add('node', Number(nodeVersion.split('.')[0]) >= 24 ? 'pass' : 'fail', 'Node ' + nodeVersion + '; Node 24+ is required.');
  for (const [id, path] of [
    ['daemon-entry', 'dist/apps/daemon/src/product-main.js'], ['mcp-entry', 'dist/apps/mcp/src/main.js'],
    ['workbench-entry', 'dist/apps/desktop/src/studio.js'], ['codex-chat-entry', 'dist/apps/desktop/src/codex-chat.js'],
    ['desktop-verification-source', 'apps/desktop/src/desktop-verification.ts'], ['desktop-verification-entry', 'dist/apps/desktop/src/desktop-verification.js'],
    ['desktop-verification-map', 'dist/apps/desktop/src/desktop-verification.js.map'],
    ['provider-setup-source','apps/desktop/src/provider-setup.ts'], ['provider-setup-entry','dist/apps/desktop/src/provider-setup.js'], ['provider-setup-host','apps/desktop/electron/provider-setup.cjs'],
    ['workspace-shell-source', 'apps/desktop/src/workspace-shell.ts'], ['workspace-shell-entry', 'dist/apps/desktop/src/workspace-shell.js'],
    ['workspace-shell-map', 'dist/apps/desktop/src/workspace-shell.js.map'],
    ...REQUIRED_FRONTEND_FILES.filter(path => /automatic-asset|asset-viewer|glb-preflight|vendor\/three/.test(path)).map((path, index) => ['viewer-file-' + index, path]),
    ['asset-downloads-source', 'apps/desktop/src/asset-downloads.ts'], ['asset-downloads-entry', 'dist/apps/desktop/src/asset-downloads.js'], ['asset-downloads-map', 'dist/apps/desktop/src/asset-downloads.js.map'], ['learning-panel-source', 'apps/desktop/src/learning-panel.ts'], ['learning-panel-entry', 'dist/apps/desktop/src/learning-panel.js'], ['learning-panel-map', 'dist/apps/desktop/src/learning-panel.js.map'], ['workflow-panel-source', 'apps/desktop/src/workflow-panel.ts'], ['workflow-panel-entry', 'dist/apps/desktop/src/workflow-panel.js'], ['workflow-panel-map', 'dist/apps/desktop/src/workflow-panel.js.map'], ['codex-history-source', 'apps/desktop/src/codex-history.ts'], ['codex-history-entry', 'dist/apps/desktop/src/codex-history.js'], ['codex-history-map', 'dist/apps/desktop/src/codex-history.js.map'], ['codex-controller-entry', 'dist/apps/daemon/src/codex-service.js'],
    ['workbench-html', 'apps/desktop/public/studio.html'], ['workbench-css', 'apps/desktop/public/studio.css'],
    ['workbench-brand-bitmap', BRAND_BITMAP_PATH], ['blender-worker', 'workers/blender/asset_worker.py'], ['skills', 'skills/registry.json'],
  ]) {
    try {
      const stat = await lstat(join(repository, path));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      if (path === BRAND_BITMAP_PATH) {
        if (stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error();
        validateBrandBitmap(await readFile(join(repository, path)));
      }
      add(id, 'pass', path);
    } catch { add(id, 'fail', 'Missing or invalid ' + path + '. Install dependencies and build from this package.'); }
  }
  const require = createRequire(join(repository, 'package.json'));
  for (const module of ['@modelcontextprotocol/sdk/client/index.js', 'zod']) {
    try { const location = require.resolve(module); const local = relative(join(repository, 'node_modules'), location); if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) throw new Error(); add('dependency:' + module, 'pass', 'Installed inside this package, not inherited from a parent checkout.'); }
    catch { add('dependency:' + module, 'fail', 'Run npm ci --ignore-scripts --no-audit --no-fund.'); }
  }
  try {
    const manifest = JSON.parse(await readFile(join(repository, 'plugin/build/manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.preferredArtifact !== 'ArcaneLocalBridge.rbxmx') throw new Error();
    const artifact = manifest.artifacts.find(item => item.name === manifest.preferredArtifact);
    const bytes = await readFile(join(repository, 'plugin/build', manifest.preferredArtifact));
    if (!artifact || bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error();
    for (const source of manifest.sources) {
      if (!/^src\/[A-Za-z][A-Za-z0-9]*(?:\.server)?\.luau$/.test(source.path)) throw new Error();
      const text = (await readFile(join(repository, 'plugin', source.path), 'utf8')).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      if (sha256(Buffer.from(text)) !== source.sha256) throw new Error();
    }
    add('plugin-artifact', 'pass', 'Modular plugin matches the manifest and current source. Installation and loading are separate.');
  } catch { add('plugin-artifact', 'fail', 'Run npm run build:plugin; plugin artifact is missing, stale, or invalid.'); }
  add('studio-runtime', 'unverified', 'No Studio connection/mutation is performed by this checker. Verify the key-only plugin from the workbench.');
  add('provider-runtime', 'unverified', 'No login/inference/client configuration is performed. The native provider owns its session.');
  add('blender-runtime', 'unverified', 'Worker files are present; installed Blender must still pass the workbench runtime probe.');
  add('release-signature', 'unverified', 'Local source packages are integrity-checked, not signed Windows installers.');
  return { schemaVersion: 1, observedAt: new Date().toISOString(), readyToLaunch: checks.every(check => check.status !== 'fail'),
    scope: 'local-runtime-files-and-dependencies', credentialsRead: false, networkUsed: false, installsPerformed: false, checks };
}

// ---------------------------------------------------------------------------
// Full environment diagnosis for `npm run doctor`. Read-only: no network, no installs, no deletes,
// no credential/config file reads. Child processes are bounded status/version queries only, and their
// raw output never leaves this module; only whitelisted fields are reported.
// ---------------------------------------------------------------------------
const GB = 1024 ** 3, MB = 1024 ** 2;
const LOW_DISK_BYTES = 5 * GB, LEFTOVER_REPORT_BYTES = 250 * MB, LEFTOVER_WARN_BYTES = 2 * GB;
const PLUGIN_FILE = 'ArcaneLocalBridge.rbxmx';
const formatBytes = bytes => bytes >= GB ? (bytes / GB).toFixed(1) + ' GB' : Math.round(bytes / MB) + ' MB';
const versionOf = text => /\b(\d+\.\d+\.\d+)\b/.exec(String(text ?? ''))?.[1] ?? null;
const safeToken = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : null;

/** Bounded one-shot helper: shell disabled, hidden window, timeout and output cap. Never throws. */
function execBounded(command, args, { timeout = 8000, env } = {}) {
  return new Promise(done => {
    try {
      execFile(command, args, { shell: false, windowsHide: true, timeout, maxBuffer: 256 * 1024, encoding: 'utf8', ...(env ? { env } : {}) },
        (error, stdout, stderr) => done({ ok: !error || Number.isInteger(error.code), code: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
          stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
    } catch { done({ ok: false, code: null, stdout: '', stderr: '' }); }
  });
}

/** Default host bindings. Tests replace any of these with fakes. */
export function defaultDoctorHost(repository = REPOSITORY) {
  const env = process.env, platform = process.platform;
  return {
    repository, platform, env, arch: process.arch, home: homedir(), nodeVersion: process.versions.node, execPath: process.execPath,
    now: () => Date.now(),
    stat: path => stat(path), lstat: path => lstat(path), readdir: (path, options) => readdir(path, options),
    readFile: (path, encoding) => readFile(path, encoding), statfs: path => statfs(path),
    exec: (command, args, options) => execBounded(command, args, options),
    productDoctor: () => productDoctor({ repository }),
    async studioProcesses() {
      if (platform !== 'win32') return [];
      const systemRoot = env.SystemRoot ?? env.SYSTEMROOT; if (!systemRoot) return null;
      const script = "Get-Process -Name RobloxStudioBeta -ErrorAction SilentlyContinue | ForEach-Object { try { ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch { 'unknown' } }";
      const result = await execBounded(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
      if (!result.ok) return null;
      return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => ({ startedAt: /^\d+$/.test(line) ? Number(line) : null }));
    },
    async discoverStudioMcp() {
      const module = await import(pathToFileURL(join(repository, 'dist/packages/studio-adapter/src/discovery.js')).href);
      return module.discoverNativeStudioExecutable();
    },
    async discoverBlender() {
      const module = await import(pathToFileURL(join(repository, 'dist/packages/asset-pipeline/src/discovery.js')).href);
      return (await module.discoverExecutables()).blender;
    },
  };
}

async function exists(host, path, kind = 'file') {
  try { const s = await host.stat(path); return kind === 'file' ? s.isFile() : s.isDirectory(); } catch { return false; }
}
function pathDirectories(host) {
  const raw = host.env.PATH ?? host.env.Path ?? '';
  const out = [];
  for (let entry of String(raw).split(host.platform === 'win32' ? ';' : delimiter).slice(0, 128)) {
    entry = entry.replace(/^"|"$/g, '');
    if (entry && isAbsolute(entry) && !out.some(item => item.toLowerCase() === entry.toLowerCase())) out.push(entry);
  }
  return out;
}
async function findOnPath(host, name) {
  const filename = name + (host.platform === 'win32' ? '.exe' : '');
  for (const directory of pathDirectories(host)) if (await exists(host, join(directory, filename))) return join(directory, filename);
  return null;
}

// ---- individual checks; each returns { id, status: ok|warn|fail, detail, fix? } ----
function checkNode(host) {
  const major = Number(String(host.nodeVersion).split('.')[0]);
  return major >= 24 ? { id: 'node', status: 'ok', detail: 'Node ' + host.nodeVersion }
    : { id: 'node', status: 'fail', detail: 'Node ' + host.nodeVersion + ' is too old.', fix: 'Install Node.js 24 or later.' };
}
async function checkElectron(host) {
  const id = 'electron';
  try {
    const wanted = JSON.parse(await host.readFile(join(host.repository, 'package.json'), 'utf8')).devDependencies?.electron ?? null;
    const installed = JSON.parse(await host.readFile(join(host.repository, 'node_modules/electron/package.json'), 'utf8')).version;
    let binary = false;
    try { const rel = (await host.readFile(join(host.repository, 'node_modules/electron/path.txt'), 'utf8')).trim(); binary = !!rel && await exists(host, join(host.repository, 'node_modules/electron/dist', rel)); } catch { /* missing */ }
    if (!binary) return { id, status: 'fail', detail: 'Electron ' + installed + ' package present but its app binary is missing.', fix: 'Run npm ci --no-audit --no-fund (allow the electron install script) to download the Electron binary.' };
    if (wanted && wanted !== installed) return { id, status: 'warn', detail: 'Electron ' + installed + ' installed; package.json pins ' + wanted + '.', fix: 'Run npm ci --no-audit --no-fund to match the lockfile.' };
    return { id, status: 'ok', detail: 'Electron ' + installed };
  } catch { return { id, status: 'fail', detail: 'Electron is not installed.', fix: 'Run npm ci --no-audit --no-fund.' }; }
}
function summarizeBuildFiles(report) {
  const failed = report.checks.filter(check => check.status === 'fail' && check.id !== 'node' && check.id !== 'plugin-artifact');
  const total = report.checks.filter(check => check.id !== 'node' && check.id !== 'plugin-artifact' && check.status !== 'unverified').length;
  if (!failed.length) return { id: 'build-files', status: 'ok', detail: total + ' required build outputs and dependencies present.' };
  const deps = failed.some(check => check.id.startsWith('dependency:'));
  return { id: 'build-files', status: 'fail', detail: failed.length + ' of ' + total + ' required files/dependencies missing: ' + failed.slice(0, 4).map(check => check.id).join(', ') + (failed.length > 4 ? ', ...' : ''),
    fix: deps ? 'Run npm ci --ignore-scripts --no-audit --no-fund, then npm run build.' : 'Run npm run build.' };
}
async function checkDistFreshness(host) {
  const id = 'dist-fresh', stale = [];
  let sources = 0;
  async function walk(relativeDir, depth) {
    if (depth > 8) return;
    let entries; try { entries = await host.readdir(join(host.repository, relativeDir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = relativeDir + '/' + entry.name;
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) await walk(rel, depth + 1); continue; }
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      sources++;
      try {
        const source = await host.stat(join(host.repository, rel));
        const built = await host.stat(join(host.repository, 'dist', rel.replace(/\.tsx?$/, '.js')));
        if (built.mtimeMs + 1000 < source.mtimeMs) stale.push(rel);
      } catch { stale.push(rel); }
    }
  }
  for (const root of ['apps', 'packages']) {
    let names; try { names = await host.readdir(join(host.repository, root), { withFileTypes: true }); } catch { continue; }
    for (const name of names) if (name.isDirectory()) await walk(root + '/' + name.name + '/src', 0);
  }
  if (!sources) return { id, status: 'warn', detail: 'No TypeScript sources found under apps/ or packages/.', fix: 'Run the doctor from an Arcane source checkout.' };
  if (!stale.length) return { id, status: 'ok', detail: 'dist/ is newer than all ' + sources + ' sources.' };
  return { id, status: 'warn', detail: stale.length + ' of ' + sources + ' sources are newer than dist/ (e.g. ' + stale.slice(0, 2).join(', ') + ').', fix: 'Run npm run build.' };
}
async function checkPluginBuild(host) {
  const id = 'plugin-build';
  const result = await host.exec(host.execPath, [join(host.repository, 'scripts/build-plugin.mjs'), '--check'], { timeout: 30000 });
  if (result.ok && result.code === 0) return { id, status: 'ok', detail: 'plugin/build matches plugin/src (build-plugin --check).' };
  const reason = /missing or stale: ([\w.]+)/.exec(result.stderr + result.stdout)?.[1];
  return { id, status: 'fail', detail: 'Plugin build is stale or invalid' + (reason ? ' (' + reason + ').' : '.'), fix: 'Run npm run build:plugin.' };
}
async function checkInstalledPlugin(host) {
  const id = 'studio-plugin';
  const local = host.env.LOCALAPPDATA;
  if (host.platform !== 'win32' || !local) return { checks: [{ id, status: 'warn', detail: 'Studio plugin folder check is Windows-only.', fix: 'Install the plugin from Arcane Settings on the Windows machine running Studio.' }], installed: null };
  const installedPath = join(local, 'Roblox', 'Plugins', PLUGIN_FILE);
  let expected = null;
  try { expected = JSON.parse(await host.readFile(join(host.repository, 'plugin/build/manifest.json'), 'utf8')).artifacts?.find(item => item.name === PLUGIN_FILE)?.sha256 ?? null; } catch { /* reported below */ }
  let installed = null;
  try { const s = await host.stat(installedPath); if (s.isFile()) installed = { mtimeMs: s.mtimeMs, sha256: sha256(await host.readFile(installedPath)) }; } catch { /* absent */ }
  if (!installed) return { checks: [{ id, status: 'warn', detail: 'Arcane plugin is not installed in Roblox Studio.', fix: 'Click Install plugin on the Arcane setup checklist (or Settings), then restart Studio.' }], installed };
  installed.current = !!expected && installed.sha256 === expected;
  if (!expected) return { checks: [{ id, status: 'warn', detail: 'Plugin installed, but plugin/build/manifest.json is unreadable so it cannot be compared.', fix: 'Run npm run build:plugin.' }], installed };
  if (installed.sha256 !== expected) return { checks: [{ id, status: 'warn', detail: 'Installed plugin is out of date (differs from plugin/build).', fix: 'Click Update plugin in Arcane Settings, then restart Studio.' }], installed };
  return { checks: [{ id, status: 'ok', detail: 'Installed plugin matches plugin/build.' }], installed };
}
async function checkStudioProcess(host, installed) {
  const id = 'studio-process';
  let processes; try { processes = await host.studioProcesses(); } catch { processes = null; }
  if (processes === null) return { id, status: 'warn', detail: 'Could not list Roblox Studio processes.', fix: 'If Studio is open after a plugin update, restart Studio.' };
  if (!processes.length) return { id, status: 'ok', detail: 'Roblox Studio is not running.' };
  if (installed && !installed.current) return { id, status: 'warn', detail: processes.length + ' Studio process(es) running with an out-of-date plugin.', fix: 'Update the plugin from Arcane Settings, then restart Roblox Studio.' };
  const older = installed ? processes.filter(item => item.startedAt !== null && item.startedAt < installed.mtimeMs) : [];
  if (older.length) return { id, status: 'warn', detail: older.length + ' Studio window(s) started before the plugin was last installed; they still run the old plugin.', fix: 'Restart Roblox Studio.' };
  return { id, status: 'ok', detail: processes.length + ' Studio process(es) running' + (installed ? ' with the current plugin file.' : '.') };
}
async function locateClaude(host) {
  return await findOnPath(host, 'claude') ?? (await exists(host, join(host.home, '.local', 'bin', 'claude' + (host.platform === 'win32' ? '.exe' : ''))) ? join(host.home, '.local', 'bin', 'claude' + (host.platform === 'win32' ? '.exe' : '')) : null);
}
async function checkClaude(host) {
  const id = 'claude-cli', command = await locateClaude(host);
  if (!command) return { check: { id, status: 'warn', detail: 'Claude Code CLI not found on PATH or in ~/.local/bin.', fix: 'Install Claude Code (native installer), then run claude auth login.' }, signedIn: false };
  const [version, auth] = await Promise.all([host.exec(command, ['--version'], { timeout: 10000 }), host.exec(command, ['auth', 'status', '--json'], { timeout: 10000 })]);
  const cliVersion = version.ok ? versionOf(version.stdout) : null;
  let parsed = null; try { const value = JSON.parse(auth.stdout); if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value; } catch { /* unknown */ }
  const label = 'Claude Code ' + (cliVersion ?? '(version unknown)');
  if (!parsed || typeof parsed.loggedIn !== 'boolean') return { check: { id, status: 'warn', detail: label + '; sign-in status unavailable.', fix: 'Run claude auth status in a terminal; update Claude Code if it fails.' }, signedIn: false };
  // Whitelisted fields only: never email, organization, or account identifiers.
  const fields = ['loggedIn=' + parsed.loggedIn, safeToken(parsed.authMethod) && 'authMethod=' + parsed.authMethod, safeToken(parsed.subscriptionType) && 'subscription=' + parsed.subscriptionType].filter(Boolean).join(', ');
  if (!parsed.loggedIn) return { check: { id, status: 'warn', detail: label + '; ' + fields + '.', fix: 'Run claude auth login in your own terminal.' }, signedIn: false };
  return { check: { id, status: 'ok', detail: label + '; ' + fields + '.' }, signedIn: true };
}
async function locateCodex(host) {
  const filename = 'codex' + (host.platform === 'win32' ? '.exe' : '');
  const onPath = await findOnPath(host, 'codex'); if (onPath) return { path: onPath };
  const userBin = join(host.home, '.local', 'bin', filename); if (await exists(host, userBin)) return { path: userBin };
  if (host.platform === 'win32' && host.env.LOCALAPPDATA) {
    const root = join(host.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'), found = [];
    try {
      for (const entry of (await host.readdir(root, { withFileTypes: true })).slice(0, 32)) {
        if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
        const full = join(root, entry.name, filename);
        try { const s = await host.stat(full); if (s.isFile()) found.push({ path: full, mtimeMs: s.mtimeMs }); } catch { /* skip */ }
      }
    } catch { /* not installed */ }
    if (found.length) return { path: found.sort((a, b) => b.mtimeMs - a.mtimeMs)[0].path, ambiguous: found.length > 1 };
  }
  if (host.platform === 'win32' && ['x64', 'arm64'].includes(host.arch)) {
    const triple = host.arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
    for (const directory of pathDirectories(host)) {
      const scope = join(directory, 'node_modules', '@openai');
      for (const root of [join(scope, 'codex', 'node_modules', '@openai', 'codex-win32-' + host.arch), join(scope, 'codex-win32-' + host.arch), join(scope, 'codex')]) {
        const full = join(root, 'vendor', triple, 'codex', 'codex.exe'); if (await exists(host, full)) return { path: full };
      }
    }
  }
  return null;
}
async function checkCodex(host) {
  const id = 'codex-cli', located = await locateCodex(host);
  if (!located) return { check: { id, status: 'warn', detail: 'Codex CLI not found.', fix: 'Install the Codex CLI, then run codex login.' }, signedIn: false };
  const [version, login] = await Promise.all([host.exec(located.path, ['--version'], { timeout: 10000 }), host.exec(located.path, ['login', 'status'], { timeout: 10000 })]);
  const label = 'Codex ' + (version.ok ? versionOf(version.stdout) ?? '(version unknown)' : '(version unknown)') + (located.ambiguous ? ' (newest of several installed builds)' : '');
  const text = [login.stdout.trim(), login.stderr.trim()].filter(Boolean).join('\n');
  // Only fixed phrases are mapped; the raw text (which may name an account or key) is never printed.
  const state = login.code === 0 && text === 'Logged in using ChatGPT' ? 'ChatGPT' : login.code === 0 && /^Logged in using an API key/.test(text) ? 'API key'
    : /^Not logged in$/.test(text) ? 'signed-out' : 'unknown';
  const ambiguity = located.ambiguous ? ' Several native Codex builds are installed; Arcane will not guess between them.' : '';
  if (state === 'signed-out') return { check: { id, status: 'warn', detail: label + '; not signed in.' + ambiguity, fix: 'Run codex login in your own terminal.' }, signedIn: false };
  if (state === 'unknown') return { check: { id, status: 'warn', detail: label + '; sign-in status unavailable.' + ambiguity, fix: 'Run codex login status in a terminal; update Codex if it fails.' }, signedIn: false };
  if (located.ambiguous) return { check: { id, status: 'warn', detail: label + '; signed in (' + state + ').' + ambiguity, fix: 'Put one codex.exe on PATH (or remove old builds via the Codex app updater).' }, signedIn: true };
  return { check: { id, status: 'ok', detail: label + '; signed in (' + state + ').' }, signedIn: true };
}
async function checkBlender(host) {
  const id = 'blender';
  let found; try { found = await host.discoverBlender(); } catch { return { id, status: 'warn', detail: 'Blender discovery unavailable (dist not built).', fix: 'Run npm run build.' }; }
  if (!found?.length) return { id, status: 'warn', detail: 'Blender not found; procedural meshes are unavailable.', fix: 'Install Blender from blender.org (default Program Files location) or add blender.exe to PATH.' };
  const executable = found[0];
  let version = /Blender (\d+(?:\.\d+)+)/.exec(basename(dirname(executable)))?.[1] ?? null;
  if (!version) { try { version = (await host.readdir(dirname(executable), { withFileTypes: true })).find(entry => entry.isDirectory() && /^\d+\.\d+$/.test(entry.name))?.name ?? null; } catch { /* unknown */ } }
  return { id, status: 'ok', detail: 'Blender ' + (version ?? '(version unknown)') + ' at ' + executable };
}
async function checkStudioMcp(host) {
  const id = 'studio-mcp';
  try {
    const found = await host.discoverStudioMcp();
    const build = /version-[a-f0-9]{16}/i.exec(found?.path ?? '')?.[0];
    return { id, status: 'ok', detail: 'Built-in Studio MCP server found and signed' + (build ? ' (' + build + ').' : '.') };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : null;
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(error?.message)) || error?.code === 'ERR_MODULE_NOT_FOUND') return { id, status: 'warn', detail: 'Studio MCP discovery unavailable (dist not built).', fix: 'Run npm run build.' };
    return { id, status: 'warn', detail: 'Built-in Studio MCP server not available' + (code ? ' (' + code + ').' : '.'), fix: 'In Roblox Studio, enable the built-in MCP server (Assistant settings), then restart Studio.' };
  }
}
async function checkDisk(host) {
  const id = 'disk-space';
  try {
    const info = await host.statfs(host.repository), free = Number(info.bavail) * Number(info.bsize);
    if (free < LOW_DISK_BYTES) return { id, status: 'warn', detail: formatBytes(free) + ' free on the Arcane drive (below 5 GB).', fix: 'Free disk space; builds, assets and Studio caches need room.' };
    return { id, status: 'ok', detail: formatBytes(free) + ' free.' };
  } catch { return { id, status: 'warn', detail: 'Free disk space unknown.', fix: 'Check free space manually (5 GB or more recommended).' }; }
}
async function directorySize(host, path, budget) {
  let total = 0; const stack = [path];
  while (stack.length) {
    if (budget.entries <= 0) { budget.truncated = true; break; }
    const current = stack.pop();
    let entries; try { entries = await host.readdir(current, { withFileTypes: true }); } catch { continue; }
    const files = [];
    for (const entry of entries) {
      if (--budget.entries <= 0) { budget.truncated = true; break; }
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full); else if (entry.isFile()) files.push(full);
    }
    for (let index = 0; index < files.length; index += 128) {
      const sizes = await Promise.all(files.slice(index, index + 128).map(full => host.lstat(full).then(s => s.size, () => 0)));
      for (const size of sizes) total += size;
    }
  }
  return total;
}
async function checkRuntimeLeftovers(host) {
  const id = 'runtime-leftovers', root = join(host.repository, 'runtime');
  let entries; try { entries = await host.readdir(root, { withFileTypes: true }); } catch { return { id, status: 'ok', detail: 'No runtime/ folder.' }; }
  const budget = { entries: 400000, truncated: false }, sizes = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === 'product') continue; // runtime/product holds live app state, not leftovers.
    const full = join(root, entry.name);
    let size = 0;
    if (entry.isDirectory()) size = await directorySize(host, full, budget);
    else if (entry.isFile()) { try { size = (await host.lstat(full)).size; } catch { /* vanished */ } }
    total += size; if (size >= LEFTOVER_REPORT_BYTES) sizes.push([entry.name, size]);
  }
  sizes.sort((a, b) => b[1] - a[1]);
  const largest = sizes.slice(0, 5).map(([name, size]) => name + ' ' + formatBytes(size)).join(', ');
  const detail = (budget.truncated ? 'At least ' : '') + formatBytes(total) + ' of private build leftovers in runtime/' + (largest ? ' (largest: ' + largest + ').' : '.');
  if (total >= LEFTOVER_WARN_BYTES) return { id, status: 'warn', detail, fix: 'Review and delete old runtime/ folders yourself if no longer needed; the doctor never deletes.' };
  return { id, status: 'ok', detail };
}
async function checkUiTestTools(host) {
  const id = 'ui-test-browser';
  let playwright = null; try { playwright = JSON.parse(await host.readFile(join(host.repository, 'node_modules/playwright-core/package.json'), 'utf8')).version; } catch { /* missing */ }
  let edge = null;
  if (host.platform === 'win32') {
    for (const base of [host.env['ProgramFiles(x86)'], host.env.ProgramFiles, host.env.LOCALAPPDATA].filter(Boolean)) {
      const candidate = join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'); if (await exists(host, candidate)) { edge = candidate; break; }
    }
  }
  const parts = [(playwright ? 'playwright-core ' + playwright : 'playwright-core missing'), (edge ? 'Edge found' : 'Edge not found')].join('; ') + ' (dev-only, for UI tests).';
  if (playwright && edge) return { id, status: 'ok', detail: parts };
  return { id, status: 'warn', detail: parts, fix: !playwright ? 'Run npm ci --no-audit --no-fund to install dev dependencies.' : 'Install Microsoft Edge, or set ARCANE_VIEWER_PRODUCT_BROWSER to a Chromium executable.' };
}

/** Runs every check. `overrides` replaces host bindings (tests inject fakes; no real processes). */
export async function runDoctor(overrides = {}) {
  const host = { ...defaultDoctorHost(overrides.repository ? resolve(overrides.repository) : REPOSITORY), ...overrides };
  const safe = async (id, run) => { try { return await run(); } catch { return { id, status: 'warn', detail: 'Check could not run.', fix: 'Re-run npm run doctor; report the issue if it persists.' }; } };
  const [base, electron, dist, pluginBuild, plugin, claude, codex, blender, mcp, disk, leftovers, ui] = await Promise.all([
    safe('build-files', () => host.productDoctor()), safe('electron', () => checkElectron(host)), safe('dist-fresh', () => checkDistFreshness(host)),
    safe('plugin-build', () => checkPluginBuild(host)), safe('studio-plugin', () => checkInstalledPlugin(host)),
    safe('claude-cli', () => checkClaude(host)), safe('codex-cli', () => checkCodex(host)), safe('blender', () => checkBlender(host)),
    safe('studio-mcp', () => checkStudioMcp(host)), safe('disk-space', () => checkDisk(host)), safe('runtime-leftovers', () => checkRuntimeLeftovers(host)),
    safe('ui-test-browser', () => checkUiTestTools(host)),
  ]);
  const studio = await safe('studio-process', () => checkStudioProcess(host, plugin.installed ?? null));
  const provider = (claude.signedIn || codex.signedIn) ? { id: 'ai-provider', status: 'ok', detail: 'At least one AI provider is signed in.' }
    : { id: 'ai-provider', status: 'fail', detail: 'Neither Claude Code nor Codex is signed in; chat will not work.', fix: 'Run claude auth login or codex login in your own terminal.' };
  const checks = [checkNode(host), electron, Array.isArray(base?.checks) ? summarizeBuildFiles(base) : base, dist, pluginBuild,
    ...(plugin.checks ?? [plugin]), studio, mcp, claude.check ?? claude, codex.check ?? codex, provider, blender, disk, leftovers, ui];
  const counts = { ok: 0, warn: 0, fail: 0 }; for (const check of checks) counts[check.status]++;
  return { schemaVersion: 2, observedAt: new Date(host.now()).toISOString(), ok: counts.fail === 0, counts,
    credentialsPrinted: false, networkUsed: false, installsPerformed: false, filesDeleted: false, checks,
    launchPreflight: base?.checks ? base : null };
}

export function formatDoctorTable(report) {
  const width = Math.max(5, ...report.checks.map(check => check.id.length));
  const lines = ['Arcane doctor (read-only: no network, no installs, no credentials shown)', '', 'STATUS  ' + 'CHECK'.padEnd(width) + '  DETAIL'];
  for (const check of report.checks) {
    lines.push((check.status === 'ok' ? 'ok' : check.status.toUpperCase()).padEnd(8) + check.id.padEnd(width) + '  ' + check.detail);
    if (check.status !== 'ok' && check.fix) lines.push(' '.repeat(8 + width + 2) + 'fix: ' + check.fix);
  }
  lines.push('', 'Summary: ' + report.counts.ok + ' ok, ' + report.counts.warn + ' warn, ' + report.counts.fail + ' fail.');
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json')) { console.error('Usage: node scripts/product-doctor.mjs [--json]'); process.exit(2); }
  const report = await runDoctor();
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatDoctorTable(report));
  if (!report.ok) process.exitCode = 1;
}
