import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productDoctor } from './product-doctor.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 2) throw new Error('Usage: node scripts/start-product.mjs');
const report = await productDoctor({ repository });
if (!report.readyToLaunch) {
  for (const check of report.checks.filter(check => check.status === 'fail')) console.error(check.id + ': ' + check.detail);
  process.exitCode = 1;
} else {
  console.log('Arcane local product. Native runtime verification remains separate from startup.');
  const child = spawn(process.execPath, [join(repository, 'dist/apps/daemon/src/product-main.js')], { cwd: repository, env: process.env, shell: false, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
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
