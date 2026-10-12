import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath, rename } from 'node:fs/promises';
import { join, parse, relative, resolve, sep } from 'node:path';
import { artifactPath, readRegularFile } from './paths.js';
import { AssetError } from './types.js';

const BYTES = 8 * 1024 * 1024;
const LOCK_DELAYS = Object.freeze([25, 75, 150]);
const errno = (error: unknown): string => {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null;
  return typeof code === 'string' && ['ENOENT','EEXIST','EPERM','EACCES','EBUSY','EIO','ENOSPC','EMFILE','ENFILE','OUTPUT_PATH'].includes(code) ? code : 'UNKNOWN';
};
export class AtomicJsonFailure extends Error {
  readonly code: string;
  constructor(readonly phase: 'path-check' | 'write' | 'replace', error: unknown) {
    const code = errno(error);
    super('Asset state could not be saved (' + phase + '/' + code + ').');
    this.name = 'AtomicJsonFailure'; this.code = code;
  }
}
interface NodeIdentity { path: string; stat: BigIntStats }
interface FilePin { stat: BigIntStats; sha256: string }
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function identity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return identity(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function unsafe(): never { throw new AssetError('OUTPUT_PATH', 'Asset state identity changed; no replacement was attempted.'); }
async function chain(directory: string): Promise<NodeIdentity[]> {
  const full = resolve(directory); let cursor = parse(full).root;
  const result: NodeIdentity[] = [];
  for (const part of [null, ...relative(cursor, full).split(sep).filter(Boolean)]) {
    if (part !== null) cursor = join(cursor, part);
    const stat = await lstat(cursor, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
    result.push({ path: cursor, stat });
  }
  if (!samePath(await realpath(full), full)) unsafe();
  return result;
}
async function pin(path: string, optional = false): Promise<FilePin | null> {
  let before: BigIntStats;
  try { before = await lstat(path, { bigint: true }); }
  catch (error) { if (optional && errno(error) === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(BYTES)) unsafe();
  const bytes = await readRegularFile(path, BYTES);
  const after = await lstat(path, { bigint: true });
  if (!sameFile(before, after) || bytes.length !== Number(before.size)) unsafe();
  return { stat: after, sha256: digest(bytes) };
}
function samePin(a: FilePin | null, b: FilePin | null): boolean {
  return a === null || b === null ? a === b : sameFile(a.stat, b.stat) && a.sha256 === b.sha256;
}

/** Atomic metadata replacement only; never retries a worker, removes a destination,
 * changes permissions or treats an ambiguous replacement as an uncommitted write.
 * Windows sharing-lock retries require both exact files and all physical ancestors
 * to remain unchanged before and after each bounded delay. Cooperative path checks
 * are not an OS sandbox against a racing local process.
 */
export async function atomicAssetJson(directory: string, filename: string, text: string): Promise<void> {
  let phase: AtomicJsonFailure['phase'] = 'path-check';
  try {
    if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > BYTES) unsafe();
    const ancestors = await chain(directory), target = artifactPath(directory, filename);
    const oldTarget = await pin(target, true), temporary = artifactPath(directory, 'state-' + randomUUID() + '.tmp');
    phase = 'write';
    const fd = await open(temporary, 'wx', 0o600);
    try { await fd.writeFile(text, 'utf8'); await fd.sync(); } finally { await fd.close(); }
    phase = 'replace';
    const source = await pin(temporary);
    if (!source || source.sha256 !== digest(Buffer.from(text))) unsafe();
    const unchanged = async () => {
      const current = await chain(directory);
      if (ancestors.length !== current.length || !ancestors.every((n, i) => samePath(n.path, current[i]!.path) && identity(n.stat, current[i]!.stat))) unsafe();
      if (!samePin(source, await pin(temporary)) || !samePin(oldTarget, await pin(target, true))) unsafe();
    };
    for (let attempt = 0; ; attempt++) {
      await unchanged();
      try { await rename(temporary, target); return; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(errno(error)) || attempt >= LOCK_DELAYS.length) throw error;
        // If rename actually committed or a file changed, fail closed instead of replaying it.
        await unchanged();
        await new Promise<void>(done => setTimeout(done, LOCK_DELAYS[attempt]));
      }
    }
  } catch (error) { throw new AtomicJsonFailure(phase, error); }
}
