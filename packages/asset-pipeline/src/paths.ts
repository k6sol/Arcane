import { constants } from 'node:fs';
import { lstat, mkdir, realpath, stat, open } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, dirname, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { AssetError } from './types.js';

export function within(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
}
export function assetName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:-|$)/i.test(value)) {
    throw new AssetError('INPUT', 'Name must be a safe lowercase slug, at most 48 characters.');
  }
  return value;
}
export function artifactPath(root: string, name: unknown): string {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name) || name.includes('..') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) {
    throw new AssetError('OUTPUT_PATH', 'Artifact must use a simple filename in the job directory.');
  }
  return resolve(root, name);
}
/** Reject junctions/symlinks in every ancestor, not merely lexical traversal. */
export async function noLinks(path: string): Promise<void> {
  const full = resolve(path); let cursor = parse(full).root;
  for (const part of relative(cursor, full).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const s = await lstat(cursor);
    if (s.isSymbolicLink()) throw new AssetError('OUTPUT_PATH', 'Symlinks and junctions are not permitted in asset paths.');
  }
}
export async function prepareOutputRoot(workspaceRoot: string, outputRoot: string): Promise<string> {
  if (!isAbsolute(workspaceRoot) || !isAbsolute(outputRoot)) throw new AssetError('OUTPUT_PATH', 'Roots must be absolute.');
  const workspace = await realpath(workspaceRoot), temp = await realpath(tmpdir()), target = resolve(outputRoot);
  if (![workspace, temp].some(root => within(root, target)) || target === workspace || target === temp) {
    throw new AssetError('OUTPUT_PATH', 'Choose an output subdirectory of the workspace or OS temporary directory.');
  }
  await noLinks(workspace);
  const missing: string[] = []; let cursor = target;
  while (true) {
    try { const s = await lstat(cursor); if (!s.isDirectory()) throw new AssetError('OUTPUT_PATH', 'Output ancestor is not a directory.'); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; missing.unshift(cursor); cursor = dirname(cursor); }
  }
  await noLinks(cursor);
  for (const dir of missing) { try { await mkdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } await noLinks(dir); }
  await noLinks(target);
  const canonical = await realpath(target);
  if (![workspace, temp].some(root => within(root, canonical))) throw new AssetError('OUTPUT_PATH', 'Output root escaped its allowed directory.');
  return canonical;
}
export async function regularFile(path: string, limit: number): Promise<number> {
  await noLinks(path); const s = await stat(path);
  if (!s.isFile() || s.nlink !== 1 || s.size < 1 || s.size > limit) throw new AssetError('ARTIFACT', 'Artifact is empty, oversized or not a regular file.');
  return s.size;
}

/** Bound allocation and verify the opened regular file, including changes during the read.
 * A trusted synchronous admission may refuse its actual opened size before allocation or reads. */
export async function readRegularFile(path: string, limit: number, admit?: (size: number) => undefined): Promise<Buffer> {
  await regularFile(path, limit);
  const before = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || initial.size < 1 || initial.size > limit || initial.ino !== before.ino || initial.dev !== before.dev) throw new AssetError('ARTIFACT', 'Artifact changed or is not a bounded regular file.');
    admit?.(initial.size);
    const bytes = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new AssetError('ARTIFACT', 'Artifact changed while reading.');
      offset += result.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset), after = await handle.stat();
    await noLinks(path);
    const named = await lstat(path);
    if (extra.bytesRead || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs || after.nlink !== 1 || named.ino !== initial.ino || named.dev !== initial.dev) throw new AssetError('ARTIFACT', 'Artifact changed while reading.');
    return bytes;
  } finally { await handle.close(); }
}
