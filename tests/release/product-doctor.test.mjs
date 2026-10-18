import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runDoctor, formatDoctorTable } from '../../scripts/product-doctor.mjs';

// Every process, Studio, MCP and Blender binding is a fake: no real child processes run.
const hash = value => createHash('sha256').update(value).digest('hex');
const PLUGIN = '<roblox>arcane plugin</roblox>';
const T0 = Date.UTC(2026, 9, 1);

async function fixture(t, { installedPlugin = PLUGIN } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'arcane-doctor-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), local = join(root, 'local'), home = join(root, 'home'), bin = join(root, 'bin');
  const write = async (path, value, mtimeMs) => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, value);
    if (mtimeMs) await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
  };
  await write(join(repo, 'package.json'), JSON.stringify({ devDependencies: { electron: '44.7.0' } }));
  await write(join(repo, 'node_modules/electron/package.json'), JSON.stringify({ version: '44.7.0' }));
  await write(join(repo, 'node_modules/electron/path.txt'), 'electron.exe');
  await write(join(repo, 'node_modules/electron/dist/electron.exe'), 'MZ');
  await write(join(repo, 'node_modules/playwright-core/package.json'), JSON.stringify({ version: '1.64.0' }));
  await write(join(repo, 'apps/daemon/src/main.ts'), 'export {};', T0);
  await write(join(repo, 'dist/apps/daemon/src/main.js'), 'export {};', T0 + 5000);
  await write(join(repo, 'plugin/build/manifest.json'), JSON.stringify({ artifacts: [{ name: 'ArcaneLocalBridge.rbxmx', sha256: hash(PLUGIN) }] }));
  if (installedPlugin !== null) await write(join(local, 'Roblox/Plugins/ArcaneLocalBridge.rbxmx'), installedPlugin, T0 + 60000);
  await write(join(bin, 'claude.exe'), 'MZ'); await write(join(bin, 'codex.exe'), 'MZ');
  await write(join(root, 'pf86/Microsoft/Edge/Application/msedge.exe'), 'MZ');
  return { root, repo, local, home, bin, write };
}

const SECRET_CLAUDE = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.com', orgId: 'org-123', orgName: 'Secret Org', subscriptionType: 'max' };
function fakeExec({ claude = SECRET_CLAUDE, codex = { code: 0, stderr: 'Logged in using ChatGPT' }, pluginCheck = 0 } = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('--check')) return pluginCheck === 0 ? { ok: true, code: 0, stdout: 'Verified', stderr: '' } : { ok: true, code: 1, stdout: '', stderr: 'Plugin artifact is missing or stale: ArcaneLocalBridge.rbxmx' };
    if (args[0] === '--version') return { ok: true, code: 0, stdout: command.includes('claude') ? '2.1.302 (Claude Code)\n' : 'codex-cli 0.162.0\n', stderr: '' };
    if (args[0] === 'auth') return { ok: true, code: claude.loggedIn ? 0 : 1, stdout: JSON.stringify(claude), stderr: '' };
    if (args[0] === 'login') return { ok: true, code: codex.code, stdout: '', stderr: codex.stderr };
    throw new Error('unexpected process ' + command);
  };
  return { exec, calls };
}
function host(f, overrides = {}) {
  return {
    repository: f.repo, platform: 'win32', arch: 'x64', home: f.home, nodeVersion: '24.21.0', execPath: 'node.exe', now: () => T0 + 120000,
    env: { PATH: f.bin, LOCALAPPDATA: f.local, 'ProgramFiles(x86)': join(f.root, 'pf86') },
    productDoctor: async () => ({ checks: [{ id: 'node', status: 'pass' }, { id: 'daemon-entry', status: 'pass' }, { id: 'studio-runtime', status: 'unverified' }] }),
    statfs: async () => ({ bavail: 100, bsize: 1024 ** 3 }),
    studioProcesses: async () => [],
    discoverStudioMcp: async () => ({ path: 'C:\\Local\\Roblox\\Versions\\version-0123456789abcdef\\StudioMCP.exe' }),
    discoverBlender: async () => ['C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe'],
    exec: fakeExec().exec,
    ...overrides,
  };
}
const find = (report, id) => report.checks.find(check => check.id === id);

test('healthy machine: all checks ok, every check has a status and failing ones a fix', async t => {
  const f = await fixture(t), { exec, calls } = fakeExec();
  const report = await runDoctor(host(f, { exec }));
  assert.equal(report.ok, true, formatDoctorTable(report));
  assert.deepEqual(report.checks.filter(check => check.status !== 'ok').map(check => check.id), []);
  for (const check of report.checks) assert.match(check.status, /^(ok|warn|fail)$/);
  assert.match(find(report, 'claude-cli').detail, /2\.1\.302.*loggedIn=true, authMethod=claude\.ai, subscription=max/);
  assert.match(find(report, 'codex-cli').detail, /0\.162\.0.*signed in \(ChatGPT\)/);
  assert.match(find(report, 'blender').detail, /Blender 4\.5/);
  assert.match(find(report, 'studio-mcp').detail, /version-0123456789abcdef/);
  assert.equal(report.networkUsed, false); assert.equal(report.filesDeleted, false); assert.equal(report.credentialsPrinted, false);
  // Only bounded status/version queries plus the plugin --check run.
  assert.deepEqual(calls.map(call => call.slice(1).join(' ')).sort(), ['--version', '--version', 'auth status --json', 'login status',
    join(f.repo, 'scripts/build-plugin.mjs') + ' --check'].sort());
});

test('claude account identifiers and codex raw text never appear in table or JSON output', async t => {
  const f = await fixture(t);
  const { exec } = fakeExec({ codex: { code: 0, stderr: 'Logged in using an API key - sk-proj-***SECRET' } });
  const report = await runDoctor(host(f, { exec }));
  for (const text of [JSON.stringify(report), formatDoctorTable(report)]) {
    for (const secret of ['person@example.com', 'org-123', 'Secret Org', 'SECRET', 'sk-proj']) assert.ok(!text.includes(secret), secret);
  }
  assert.match(find(report, 'codex-cli').detail, /signed in \(API key\)/);
});

test('no signed-in provider fails; missing CLIs and stale plugin build give actionable fixes', async t => {
  const f = await fixture(t);
  const { exec } = fakeExec({ claude: { loggedIn: false }, codex: { code: 1, stderr: 'Not logged in' }, pluginCheck: 1 });
  let report = await runDoctor(host(f, { exec }));
  assert.equal(report.ok, false);
  assert.equal(find(report, 'ai-provider').status, 'fail');
  assert.match(find(report, 'claude-cli').fix, /claude auth login/);
  assert.match(find(report, 'codex-cli').fix, /codex login/);
  assert.equal(find(report, 'plugin-build').status, 'fail');
  assert.match(find(report, 'plugin-build').detail, /ArcaneLocalBridge\.rbxmx/);
  report = await runDoctor(host(f, { env: { PATH: '', LOCALAPPDATA: f.local } }));
  assert.equal(find(report, 'claude-cli').status, 'warn'); assert.match(find(report, 'claude-cli').detail, /not found/);
  assert.equal(find(report, 'codex-cli').status, 'warn'); assert.match(find(report, 'codex-cli').detail, /not found/);
  assert.equal(find(report, 'ai-provider').status, 'fail');
  assert.equal(find(report, 'ui-test-browser').status, 'warn');
});

test('installed plugin: missing, outdated, and Studio started before the plugin file', async t => {
  let f = await fixture(t, { installedPlugin: null });
  let report = await runDoctor(host(f));
  assert.equal(find(report, 'studio-plugin').status, 'warn'); assert.match(find(report, 'studio-plugin').detail, /not installed/);
  f = await fixture(t, { installedPlugin: 'old plugin' });
  report = await runDoctor(host(f, { studioProcesses: async () => [{ startedAt: T0 + 90000 }] }));
  assert.match(find(report, 'studio-plugin').detail, /out of date/);
  assert.equal(find(report, 'studio-process').status, 'warn'); assert.match(find(report, 'studio-process').fix, /restart Roblox Studio/i);
  f = await fixture(t);
  report = await runDoctor(host(f, { studioProcesses: async () => [{ startedAt: T0 }] }));
  assert.equal(find(report, 'studio-plugin').status, 'ok');
  assert.equal(find(report, 'studio-process').status, 'warn'); assert.equal(find(report, 'studio-process').fix, 'Restart Roblox Studio.');
  report = await runDoctor(host(f, { studioProcesses: async () => [{ startedAt: T0 + 90000 }] }));
  assert.equal(find(report, 'studio-process').status, 'ok');
});

test('stale dist, low disk, large runtime leftovers, missing Blender and Studio MCP warn without deleting', async t => {
  const f = await fixture(t);
  await f.write(join(f.repo, 'apps/daemon/src/main.ts'), 'export const changed = 1;', T0 + 600000);
  await f.write(join(f.repo, 'runtime/package-snapshot-a/big.bin'), 'x');
  await f.write(join(f.repo, 'runtime/product/state.json'), '{}');
  const { lstat } = await import('node:fs/promises');
  const report = await runDoctor(host(f, {
    statfs: async () => ({ bavail: 2, bsize: 1024 ** 3 }),
    lstat: async path => path.includes('package-snapshot-a') ? { size: 3 * 1024 ** 3 } : lstat(path),
    discoverBlender: async () => [],
    discoverStudioMcp: async () => { const error = new Error('No vetted official StudioMCP.exe was found.'); error.code = 'STUDIO_EXECUTABLE'; throw error; },
  }));
  assert.equal(find(report, 'dist-fresh').status, 'warn'); assert.equal(find(report, 'dist-fresh').fix, 'Run npm run build.');
  assert.equal(find(report, 'disk-space').status, 'warn'); assert.match(find(report, 'disk-space').detail, /2\.0 GB free/);
  const leftovers = find(report, 'runtime-leftovers');
  assert.equal(leftovers.status, 'warn'); assert.match(leftovers.detail, /package-snapshot-a 3\.0 GB/); assert.doesNotMatch(leftovers.detail, /product/);
  assert.match(leftovers.fix, /never deletes/);
  assert.equal(find(report, 'blender').status, 'warn');
  assert.equal(find(report, 'studio-mcp').status, 'warn'); assert.match(find(report, 'studio-mcp').detail, /STUDIO_EXECUTABLE/);
  assert.equal(report.ok, true); // warnings never fail the run
});

test('old Node and a throwing check are reported, not crashed; table lists fixes and summary', async t => {
  const f = await fixture(t);
  const report = await runDoctor(host(f, { nodeVersion: '22.1.0', statfs: async () => { throw new Error('boom'); },
    productDoctor: async () => ({ checks: [{ id: 'node', status: 'fail' }, { id: 'dependency:zod', status: 'fail' }] }) }));
  assert.equal(find(report, 'node').status, 'fail');
  assert.equal(find(report, 'build-files').status, 'fail'); assert.match(find(report, 'build-files').fix, /npm ci/);
  assert.equal(find(report, 'disk-space').status, 'warn');
  const table = formatDoctorTable(report);
  assert.match(table, /^FAIL\s+node\s+Node 22\.1\.0/m);
  assert.match(table, /fix: Install Node\.js 24 or later\./);
  assert.match(table, new RegExp('Summary: ' + report.counts.ok + ' ok, ' + report.counts.warn + ' warn, ' + report.counts.fail + ' fail\\.'));
});
