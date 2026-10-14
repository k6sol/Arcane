import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productDoctor } from './product-doctor.mjs';
import { managedCodeVerificationConfiguration } from './managed-luau-compiler.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerEnvironmentKeys = ['ARCANE_LUAU_COMPILER_PATH', 'ARCANE_LUAU_COMPILER_SHA256', 'ARCANE_LUAU_EVIDENCE_DIRECTORY'];

/** Trusted launcher environment only; the CLI still accepts no tool-selection arguments. */
export function browserDaemonEnvironment({ repository: productRoot = repository, env = process.env } = {}) {
  const environment = { ...env };
  // Presence, including empty/partial/invalid values, keeps the caller's exact
  // configuration authoritative. Windows environment names are case-insensitive.
  if (Object.keys(environment).some(name => compilerEnvironmentKeys.includes(process.platform === 'win32' ? name.toUpperCase() : name))) return environment;
  const projectDirectory = process.platform === 'win32'
    ? Object.entries(environment).find(([name]) => name.toUpperCase() === 'ARCANE_PROJECT')?.[1]
    : environment.ARCANE_PROJECT;
  const projectPath = resolve(productRoot, projectDirectory ?? productRoot);
  // This explicitly represents absent browser environment configuration. It
  // does not read or share Electron's saved settings, credentials or custom tools.
  const codeVerification = { daemonConfiguration: () => ({ environment: {}, settingsHash: null, failure: null }) };
  const verification = managedCodeVerificationConfiguration({ codeVerification, project: { projectPath }, productRoot });
  return { ...environment, ...verification.environment };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/start-product.mjs');
  const report = await productDoctor({ repository });
  if (!report.readyToLaunch) {
    for (const check of report.checks.filter(check => check.status === 'fail')) console.error(check.id + ': ' + check.detail);
    process.exitCode = 1;
  } else {
    console.log('Arcane local product. Native runtime verification remains separate from startup.');
    const child = spawn(process.execPath, [join(repository, 'dist/apps/daemon/src/product-main.js')], { cwd: repository, env: browserDaemonEnvironment(), shell: false, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    child.once('error', () => { console.error('Arcane daemon could not start. No login, installation, or fallback was attempted.'); process.exitCode = 1; });
    child.once('close', code => { process.exitCode = code ?? 1; });
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      if (stopping || child.exitCode !== null) return; stopping = true;
      if (child.connected) child.send({ type: 'arcane-shutdown', protocolVersion: 1 }, error => { if (error && child.exitCode === null) child.kill(); });
      else child.kill();
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 15000); timer.unref();
      child.once('close', () => clearTimeout(timer));
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
