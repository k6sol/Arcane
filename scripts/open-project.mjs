import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productDoctor } from './product-doctor.mjs';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: npm run open:project -- <absolute-existing-project-directory>';
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function absoluteDirectory(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value) || !isAbsolute(value) || /^(?:\\\\|\/\/)/.test(value)) {
    throw new Error('Select an absolute local project directory; UNC/device paths and control characters are unsupported.');
  }
  const root = parse(value).root;
  const parts = value.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//);
  if (parts.some(part => part === '.' || part === '..') || (process.platform === 'win32' &&
      (!/^[a-z]:[\\/]$/i.test(root) || parts.some(part => /[<>:"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) {
    throw new Error('Select a direct local directory without traversal or ambiguous path segments.');
  }
  const path = resolve(value);
  if (samePath(path, parse(path).root)) throw new Error('Select a project directory, not a filesystem root.');
  return path;
}

// Metadata only: never enumerate or read the selected project's contents.
async function directDirectory(path, allowMissing = false) {
  let current = path;
  for (;;) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(current), current)) {
        throw new Error('Project and runtime directories cannot contain links or redirected paths.');
      }
    } catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('The selected directory must already exist.');
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Trusted host seam for offline tests; the human CLI accepts only the project path. */
export async function projectLaunchPlan(projectDirectory, { repository = REPOSITORY, env = process.env } = {}) {
  const selected = absoluteDirectory(projectDirectory);
  await directDirectory(selected);
  const projectPath = await realpath(selected);
  const source = absoluteDirectory(repository);
  await directDirectory(source);
  const cwd = await realpath(source);
  const identity = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
  const projectId = createHash('sha256').update(identity).digest('hex');
  const stateDirectory = join(cwd, 'runtime', 'projects', projectId);
  await directDirectory(stateDirectory, true);
  const port = env.ARCANE_PORT ?? '0';
  if (!/^(?:0|[1-9]\d{0,4})$/.test(port) || Number(port) > 65535) throw new Error('ARCANE_PORT must be an integer 0..65535.');
  return {
    projectPath, stateDirectory, executable: process.execPath,
    args: [join(cwd, 'dist', 'apps', 'daemon', 'src', 'product-main.js')], cwd,
    env: { ...env, ARCANE_PROJECT: projectPath, ARCANE_STATE_DIRECTORY: stateDirectory, ARCANE_PORT: port },
  };
}

async function main() {
  if (process.argv.length !== 3) { console.error(USAGE); process.exitCode = 2; return; }
  let plan;
  try { plan = await projectLaunchPlan(process.argv[2]); }
  catch (error) { console.error(error.message + '\n' + USAGE); process.exitCode = 2; return; }
  const report = await productDoctor({ repository: plan.cwd });
  if (!report.readyToLaunch) {
    for (const check of report.checks.filter(check => check.status === 'fail')) console.error(check.id + ': ' + check.detail);
    process.exitCode = 1; return;
  }
  await directDirectory(plan.stateDirectory, true);
  await mkdir(plan.stateDirectory, { recursive: true, mode: 0o700 });
  await directDirectory(plan.stateDirectory);
  console.log('Arcane project: ' + plan.projectPath);
  console.log('Open the private workbench link below. Ctrl+C closes this project sidecar.');
  const child = spawn(plan.executable, plan.args, {
    cwd: plan.cwd, env: plan.env, shell: false, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  child.once('error', () => { console.error('Arcane project daemon could not start.'); process.exitCode = 1; });
  child.once('close', code => { process.exitCode = code ?? 1; });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    if (stopping || child.exitCode !== null) return;
    stopping = true;
    if (child.connected) child.send({ type: 'arcane-shutdown', protocolVersion: 1 }, error => {
      if (error && child.exitCode === null) child.kill();
    });
    else child.kill();
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 15000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  });
}

if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main().catch(() => { console.error('Arcane project startup failed. Check the local build, dependencies and runtime directory.'); process.exitCode = 1; });
}
