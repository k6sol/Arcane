import { lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, parse, sep, join } from 'node:path';
import type { Stats } from 'node:fs';
import { StudioTestError } from './contracts.js';

export const FILE_LIMITS = Object.freeze({ records: 512, recordBytes: 8192, pathCharacters: 2048, directoryEntries: 514 });
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export function requireDirectory(stat: Pick<Stats, 'isSymbolicLink' | 'isDirectory'>): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StudioTestError('JOURNAL_FAILED');
}
export function requireRegularFile(stat: Pick<Stats, 'isFile' | 'isSymbolicLink' | 'nlink' | 'size'>): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > FILE_LIMITS.recordBytes)
    throw new StudioTestError('JOURNAL_FAILED');
}
/** Validate caller paths and every existing ancestor BEFORE mkdir/open/unlink.
 * Trusted root must exist. No junction/symlink/hardlink or alternate-stream targets.
 * This is a local filesystem guard, not protection from a hostile OS racing opens.
 */
export async function checkedDirectory(input: string, allowedRoot: string): Promise<string> {
  if (!isAbsolute(input) || !isAbsolute(allowedRoot) || input.length > FILE_LIMITS.pathCharacters || /[\u0000-\u001f]/.test(input))
    throw new StudioTestError('JOURNAL_FAILED');
  const tail = input.slice(parse(input).root.length), segments = tail.split(/[\\/]/);
  if (segments.some(s => !s || s === '.' || s === '..' || /[:*?"<>|]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))
    throw new StudioTestError('JOURNAL_FAILED');
  const root = resolve(allowedRoot), destination = resolve(input), rel = relative(root, destination);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || rel.split(sep).length > 16)
    throw new StudioTestError('JOURNAL_FAILED');
  const chain: string[] = [];
  for (let current = destination; ; current = dirname(current)) { chain.push(current); if (current === dirname(current)) break; }
  for (const path of chain.reverse()) {
    try { requireDirectory(await lstat(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!samePath(await realpath(root), root)) throw new StudioTestError('JOURNAL_FAILED');
  return destination;
}
export async function checkedFile(directory: string, name: string, allowMissing: boolean): Promise<string> {
  if (!/^(?:\d{5}\.json|writer\.lock)$/.test(name)) throw new StudioTestError('JOURNAL_FAILED');
  const path = join(directory, name);
  try {
    const stat = await lstat(path);
    requireRegularFile(stat);
  } catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path;
}
export async function checkedEntries(directory: string): Promise<string[]> {
  const files = await readdir(directory);
  if (files.length > FILE_LIMITS.directoryEntries || files.some(p => !/^(?:\d{5}\.json|writer\.lock)$/.test(p)))
    throw new StudioTestError('JOURNAL_FAILED');
  return files;
}

