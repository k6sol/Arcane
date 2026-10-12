import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyWindowsBundle } from './package-windows.mjs';
import policy from '../apps/desktop/electron/policy.cjs';
const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function checkWindowsExecutable(directory) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !isAbsolute(directory)) throw new Error('Use a Windows x64 host and an absolute Arcane bundle directory.');
  const before = await verifyWindowsBundle(directory);
  const executable = await policy.directPath(join(directory, 'Arcane.exe'), 'file');
  const root = join(repository, 'runtime', 'verification'); await policy.directPath(root, 'directory', true); await mkdir(root, { recursive: true });
  const reportDirectory = await mkdtemp(join(root, 'windows-executable-')); await policy.directPath(reportDirectory);
  const originalBytes = await readFile(executable), originalDigest = digest(originalBytes);
  // Electron-specific Node/process injection is deliberately not inherited.
  const env = policy.daemonEnvironment(process.env, { productRoot: join(directory,'resources','product'), stateRoot: join(reportDirectory,'profile','runtime','product'), projectPath: reportDirectory });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--arcane-smoke', reportDirectory], { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, text = '';
    const collect = chunk => { bytes += chunk.length; if (bytes > 65536) { child.kill(); reject(new Error('Executable diagnostics exceeded their bound.')); } else text += chunk.toString('utf8'); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Executable smoke deadline exceeded; retained report must be inspected.')); }, 60000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('The verified executable could not be launched. No security settings were changed.')); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, diagnostics: text }); });
  });
  if (result.code !== 0) throw new Error('Executable verification failed. Inspect ' + reportDirectory + '; no retry was attempted.');
  const raw = await readFile(join(reportDirectory, 'checks.json')); if (raw.length > 32768) throw new Error('Oversized executable report.');
  const report = JSON.parse(raw.toString('utf8'));
  if (report.schemaVersion !== 1 || report.kind !== 'arcane-windows-executable-smoke' || report.inferenceStarted !== false || report.studioOperations !== 0 || !report.checks || Object.keys(report.checks).length < 13 || Object.values(report.checks).some(value => value !== true)) throw new Error('Incomplete executable verification.');
  if (digest(await readFile(executable)) !== originalDigest) throw new Error('Executable changed during verification.');
  const after = await verifyWindowsBundle(directory); if (after.manifestSha256 !== before.manifestSha256) throw new Error('Bundle changed during verification.');
  const proof = { schemaVersion: 1, executable, directory, reportDirectory, screenshot: join(reportDirectory,'workspace.png'), manifestSha256: after.manifestSha256,
    checks: report.checks, elapsed: report.elapsed, inferenceStarted: false, studioOperations: 0, signed: false, fullProductVerified: false };
  await writeFile(join(reportDirectory,'verification.json'), JSON.stringify(proof,null,2)+'\n', { flag: 'wx' }); return proof;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-windows-executable.mjs ABSOLUTE_BUNDLE_DIRECTORY');
  console.log(JSON.stringify(await checkWindowsExecutable(process.argv[2]),null,2));
}
