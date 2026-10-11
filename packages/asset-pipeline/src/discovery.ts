import { access, realpath, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { AssetError } from './types.js';

export interface Executables { blender: string[]; python: string[] }
export interface DiscoveryOptions { env?: NodeJS.ProcessEnv; knownProgramFiles?: string[]; blenderExecutable?: string; pythonExecutable?: string }
async function directories(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(d => d.isDirectory() && !d.isSymbolicLink()).map(d => d.name).sort().slice(0, 32); }
  catch { return []; }
}
async function native(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths.slice(0, 256)) {
    if (!isAbsolute(path) || /[\r\n\0]/.test(path) || /\.(?:bat|cmd|ps1)$/i.test(path) || /[\\/]WindowsApps[\\/]/i.test(path)) continue;
    try { if (!(await stat(path)).isFile()) continue; await access(path, constants.X_OK); const canonical = await realpath(path); if (!found.includes(canonical)) found.push(canonical); }
    catch { /* read-only candidate miss */ }
    if (found.length === 16) break;
  }
  return found;
}
/** Bounded, read-only discovery. No registry, user settings, downloads or installers. */
export async function discoverExecutables(options: DiscoveryOptions = {}): Promise<Executables> {
  for (const explicit of [options.blenderExecutable, options.pythonExecutable]) {
    if (explicit && (!isAbsolute(explicit) || /\.(?:bat|cmd|ps1)$/i.test(explicit))) throw new AssetError('PROCESS_PATH', 'Explicit runtime must be an absolute native executable.');
  }
  const env = options.env ?? process.env, win = process.platform === 'win32';
  const blender = options.blenderExecutable ? [options.blenderExecutable] : [];
  const python = options.pythonExecutable ? [options.pythonExecutable] : [];
  const programFiles = options.knownProgramFiles ?? [env.ProgramFiles, env['ProgramFiles(x86)']].filter((p): p is string => !!p);
  for (const root of programFiles.slice(0, 8)) {
    if (!isAbsolute(root)) continue;
    const foundation = join(root, 'Blender Foundation');
    const versions = (await directories(foundation)).filter(n => /^Blender \d+(?:\.\d+)*$/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) blender.push(join(foundation, version, win ? 'blender.exe' : 'blender'));
    for (const version of (await directories(root)).filter(n => /^Python\d+$/.test(n))) python.push(join(root, version, win ? 'python.exe' : 'python3'));
  }
  for (const entry of (env.PATH ?? env.Path ?? '').split(delimiter).slice(0, 128)) {
    const dir = entry.replace(/^"|"$/g, ''); if (!isAbsolute(dir)) continue;
    blender.push(join(dir, win ? 'blender.exe' : 'blender'));
    for (const name of win ? ['python.exe', 'python3.exe'] : ['python3', 'python']) python.push(join(dir, name));
  }
  const installed = await native(blender);
  // Blender's bundled Python is a real local runtime; Windows Store aliases are skipped.
  for (const executable of installed) {
    for (const version of (await directories(dirname(executable))).filter(n => /^\d+\.\d+$/.test(n))) {
      python.unshift(join(dirname(executable), version, 'python', 'bin', win ? 'python.exe' : 'python3'));
    }
  }
  return { blender: options.blenderExecutable ? await native([options.blenderExecutable]) : installed,
    python: await native(options.pythonExecutable ? [options.pythonExecutable] : python) };
}
