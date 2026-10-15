import { resolve, join, dirname, relative, isAbsolute, sep, parse } from 'node:path';
import { mkdir, lstat, realpath, opendir } from 'node:fs/promises';

const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
};
/** Owned subtrees whose contents grow with normal use. Their owners verify each
 * file at use (asset reads refuse links and hardlinks), so startup validates
 * only the subtree root and never refuses a project because history grew. */
export const STATE_CONTENT_SUBTREES: readonly string[] = Object.freeze(['assets']);
export const STATE_VALIDATION_ENTRY_LIMIT = 4096;
export const STATE_VALIDATION_DEPTH_LIMIT = 16;

export async function directStateDirectory(path: string): Promise<void> {
  let current = path;
  for (;;) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(current), current)) {
        throw new Error('ARCANE_STATE_DIRECTORY cannot contain links or redirected directories.');
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function validatedStateDirectory(value: string, runtimeRoot: string): Promise<string> {
  if (!value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || /^(?:\\\\|\/\/)/.test(value)) {
    throw new Error('ARCANE_STATE_DIRECTORY must be an absolute local directory inside Arcane/runtime.');
  }
  const root = parse(value).root;
  const parts = value.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//);
  if (parts.some(part => part === '.' || part === '..') || (process.platform === 'win32' &&
      (!/^[a-z]:[\\/]$/i.test(root) || parts.some(part => /[<>:"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) {
    throw new Error('ARCANE_STATE_DIRECTORY contains an unsafe path segment.');
  }
  const path = resolve(value), runtime = join(runtimeRoot, 'runtime');
  if (!inside(runtime, path)) throw new Error('ARCANE_STATE_DIRECTORY must stay strictly inside Arcane/runtime.');
  await directStateDirectory(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await directStateDirectory(path);
  const physicalRuntime = await realpath(runtime), physicalPath = await realpath(path);
  if (!inside(physicalRuntime, physicalPath)) throw new Error('ARCANE_STATE_DIRECTORY resolves outside Arcane/runtime.');
  // Inspect only owned state metadata, never project files or credential contents.
  // Reject nested links, non-regular files and hardlinked databases/descriptors too.
  let entries = 0;
  async function inspect(directory: string, depth: number): Promise<void> {
    if (depth > STATE_VALIDATION_DEPTH_LIMIT) throw new Error('Arcane runtime state exceeds the validation depth limit.');
    for await (const entry of await opendir(directory)) {
      if (++entries > STATE_VALIDATION_ENTRY_LIMIT) throw new Error('Arcane runtime state exceeds the validation entry limit.');
      const child = join(directory, entry.name), info = await lstat(child);
      if (info.isSymbolicLink() || !samePath(await realpath(child), child) || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
        throw new Error('Arcane runtime state cannot contain links or non-regular files.');
      }
      if (info.isDirectory() && !(depth === 0 && STATE_CONTENT_SUBTREES.some(name => samePath(name, entry.name)))) await inspect(child, depth + 1);
    }
  }
  await inspect(physicalPath, 0);
  return physicalPath;
}
