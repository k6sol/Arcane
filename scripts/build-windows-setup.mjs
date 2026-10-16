import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWindowsSetupPayload, WINDOWS_SETUP_KIT_FILES } from './windows-setup-payload.mjs';
import { runBoundedChild } from './check-windows-executable.mjs';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_SOURCES = ['PayloadArchive.cs', 'KitVerifier.cs', 'InstallProcess.cs', 'StageDirectory.cs', 'SetupForm.cs',
  'InstalledRecord.cs', 'OperationLease.cs', 'Launcher.cs', 'OwnedFiles.cs', 'SetupOwnership.cs', 'PostInstall.cs', 'SetupPath.cs'].map(name => 'installer/' + name);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function direct(path, directory = false, allowHardlinks = false) {
  const stat = await fs.lstat(path), canonical = await fs.realpath(path);
  if (stat.isSymbolicLink() || canonical.toLowerCase() !== path.toLowerCase() || (directory ? !stat.isDirectory() : !stat.isFile() || !allowHardlinks && stat.nlink !== 1)) throw new Error('Setup build inputs must be direct paths.');
  return stat;
}
/** Produces an unsigned runnable per-user setup. It never launches the setup,
 * installs the application, creates shortcuts or writes registration. */
export async function buildWindowsSetup({ bundle, outputParent, repository = REPOSITORY } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || ![bundle, outputParent, repository].every(path => typeof path === 'string' && isAbsolute(path) && path === resolve(path))) {
    throw new Error('Build setup on Windows x64 with absolute bundle, source and output paths.');
  }
  await direct(outputParent, true); await direct(repository, true);
  const sources = [];
  for (const path of [...NATIVE_SOURCES, 'installer/setup.manifest', 'installer/launcher.manifest', 'apps/desktop/electron/icon.ico',
    'scripts/build-windows-setup.mjs', 'scripts/windows-setup-payload.mjs', 'scripts/check-windows-executable.mjs',
    'apps/desktop/electron/policy.cjs', ...WINDOWS_SETUP_KIT_FILES]) {
    await direct(join(repository, path)); sources.push({ path, sha256: await digest(join(repository, path)) });
  }
  const owned = await fs.mkdtemp(join(outputParent, 'arcane-setup-build-'));
  const executable = join(owned, 'Arcane-Setup.exe'), bootstrap = join(owned, 'bootstrap.exe');
  // Native .NET compiler and shell APIs retain legacy path constraints.
  if (executable.length > 259) throw Object.assign(new Error('Choose a shorter setup output directory.'), { retainedDirectory: owned });
  const progress = phase => console.log(JSON.stringify({ phase, owned }));
  try {
    progress('payload');
    const payload = await createWindowsSetupPayload().build({ bundle, kitRoot: repository, output: join(owned, 'payload.zip') });
    for (const file of payload.kitFiles) {
      const source = sources.find(entry => 'kit/' + entry.path === file.path);
      if (!source || source.sha256 !== file.sha256) throw new Error('Payload kit differs from the admitted build source.');
    }
    // Windows servicing keeps legitimate hard links to its inbox compiler.
    // Source, payload and output paths still require a single link.
    const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'); await direct(compiler, false, true);
    const compilerSha256 = await digest(compiler);
    const icon = join(repository, 'apps/desktop/electron/icon.ico'); await direct(icon);
    const environment = { SystemRoot: process.env.SystemRoot, TEMP: owned, TMP: owned };
    progress('compile-launcher');
    const launcher = join(owned, 'launcher.exe');
    const launcherBuild = await runBoundedChild(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+',
      '/main:Arcane.Installer.LauncherEntry', '/out:' + launcher, '/win32icon:' + icon,
      '/win32manifest:' + join(repository, 'installer/launcher.manifest'), '/reference:System.Windows.Forms.dll',
      '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll',
      ...['Launcher.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs'].map(name => join(repository, 'installer', name))],
    { cwd: owned, env: environment, deadlineMs: 120000 });
    await fs.writeFile(join(owned, 'launcher-compile.log'), launcherBuild.output, { flag: 'wx' });
    if (launcherBuild.code !== 0) throw new Error('Launcher compilation failed; inspect retained launcher-compile.log.');
    const launcherStat = await direct(launcher), launcherSha256 = await digest(launcher);
    if (launcherStat.size < 1 || launcherStat.size > 64 * 1024 * 1024) throw new Error('Launcher size is invalid.');
    const pinSource = join(owned, 'SetupPins.cs');
    await fs.writeFile(pinSource, 'namespace Arcane.Installer { internal static class SetupPins { public const string PayloadSha256 = "' + payload.payloadSha256 + '"; public const string KitManifestSha256 = "' + payload.kitManifestSha256 + '"; public const int MaximumRelativePathChars = ' + payload.maximumRelativePathChars + '; public const long LauncherBytes = ' + launcherStat.size + '; public const string LauncherSha256 = "' + launcherSha256 + '"; } }\n', { flag: 'wx' });
    const args = ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/main:Arcane.Installer.SetupEntry', '/out:' + bootstrap,
      '/win32icon:' + icon, '/win32manifest:' + join(repository, 'installer/setup.manifest'),
      '/resource:' + launcher + ',Arcane.Launcher',
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll',
      ...NATIVE_SOURCES.map(path => join(repository, path)), pinSource];
    progress('compile');
    const result = await runBoundedChild(compiler, args, { cwd: owned, env: environment, deadlineMs: 120000 });
    await fs.writeFile(join(owned, 'compile.log'), result.output, { flag: 'wx' });
    if (result.code !== 0) throw new Error('Setup compilation failed; inspect retained compile.log.');
    if (await digest(launcher) !== launcherSha256) throw new Error('Launcher changed during setup compilation.');
    if (await digest(compiler) !== compilerSha256) throw new Error('Setup compiler changed during the build.');
    const prefixStat = await direct(bootstrap), prefixSha256 = await digest(bootstrap), header = await fs.open(bootstrap, 'r');
    try { const bytes = Buffer.alloc(64); const read = await header.read(bytes, 0, bytes.length, 0); if (read.bytesRead !== 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Setup compiler did not produce a PE executable.'); } finally { await header.close(); }
    progress('assemble');
    const output = await fs.open(executable, 'wx', 0o600);
    try {
      for (const [path, expected] of [[bootstrap, prefixSha256], [payload.output, payload.payloadSha256]]) {
        const hash = createHash('sha256'); let copied = 0;
        for await (const chunk of createReadStream(path)) { copied += chunk.length; if (copied > prefixStat.size + payload.bytes) throw new Error('Setup input expanded during assembly.'); hash.update(chunk); await output.writeFile(chunk); }
        if (hash.digest('hex') !== expected) throw new Error('Setup input changed during assembly.');
      }
      const footer = Buffer.alloc(64); Buffer.from('ARCANE-SETUP-V1\0').copy(footer); footer.writeBigUInt64LE(BigInt(prefixStat.size), 16); footer.writeBigUInt64LE(BigInt(payload.bytes), 24); Buffer.from(payload.payloadSha256, 'hex').copy(footer, 32);
      await output.writeFile(footer); await output.sync();
    } finally { await output.close(); }
    for (const file of sources) if (await digest(join(repository, file.path)) !== file.sha256) throw new Error('Setup source changed during the build.');
    const afterPayload = await digest(payload.output); if (afterPayload !== payload.payloadSha256) throw new Error('Setup payload changed during assembly.');
    const stat = await direct(executable);
    if (stat.size !== prefixStat.size + payload.bytes + 64) throw new Error('Incomplete setup assembly.');
    const receipt = { schemaVersion: 1, kind: 'arcane-windows-setup-build', owned, executable, executableSha256: await digest(executable), bytes: stat.size,
      payload, sources, launcher: { path: launcher, bytes: launcherStat.size, sha256: launcherSha256 },
      manifestSha256: sha(await fs.readFile(join(repository, 'installer/setup.manifest'))), compiler, compilerSha256,
      runnableSetupBuilt: true, setupLaunched: false, guiAccepted: false, applicationSigned: false, installerSigned: false,
      shortcuts: false, registration: false, cleanMachineAccepted: false, studioOperations: 0, inferenceStarted: false, fullProductVerified: false };
    await fs.writeFile(join(owned, 'setup-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    progress('built'); return receipt;
  } catch (error) { if (error instanceof Error) error.retainedDirectory = owned; throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--bundle' || args[2] !== '--output-parent') throw new Error('Usage: node scripts/build-windows-setup.mjs --bundle ABSOLUTE --output-parent ABSOLUTE');
  console.log(JSON.stringify(await buildWindowsSetup({ bundle: args[1], outputParent: args[3] }), null, 2));
}
