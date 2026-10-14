import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, rmdirSync, unlinkSync, writeSync, type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { types } from 'node:util';

export interface ScriptSourceVerification {
  sourceSha256: string;
  compilerSha256: string;
  syntaxVerified: true;
  elapsedMs: number;
}

export interface ScriptSourceVerifier {
  verify(source: string, signal?: AbortSignal): Promise<ScriptSourceVerification>;
  dispose(): void;
}

interface Options {
  /** Trusted host configuration; never accept compiler selection or flags from a route. */
  compiler: { executablePath: string; sha256: string };
  /** Existing, canonical, host-owned private state directory. */
  directory: string;
}

const LIMITS = Object.freeze({
  sourceBytes: 100 * 1024, compilerBytes: 32 * 1024 * 1024, outputBytes: 64 * 1024,
  deadlineMs: 10_000, terminationMs: 500, pathBytes: 2048, pathDepth: 64,
});
const HASH = /^[a-f0-9]{64}$/;
const SUMMARY = /^Compiled \d+ KLOC into \d+ KB bytecode \(read \d+\.\d+s, parse \d+\.\d+s, compile \d+\.\d+s\)\r?\n$/;
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function rejected(): Error { return new Error('Script source verification failed.'); }
function reject(): never { throw rejected(); }

// Match the workflow verifier's descriptor-only configuration policy. In particular,
// getters/proxies, caller flags, environment overrides and diagnostic claims add no authority.
function fields(value: unknown, names: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) reject();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length || names.some(name =>
    !Object.hasOwn(descriptors, name) || !Object.hasOwn(descriptors[name]!, 'value') ||
    !descriptors[name]!.enumerable)) reject();
}

function absolute(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value !== resolve(value) ||
    Buffer.byteLength(value) > LIMITS.pathBytes || /[\u0000-\u001f\u007f]/.test(value) ||
    (process.platform === 'win32' && !/^[a-z]:\\/i.test(value))) reject();
  // No alternate streams, device names, trailing-dot aliases or wildcard components.
  const root = parse(value).root;
  if (value.slice(root.length).split(sep).some(part => !part || /[<>:"|?*]/.test(part) ||
    /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) reject();
  return value;
}

interface NodeIdentity { path: string; stat: BigIntStats }
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.nlink === b.nlink && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** All ancestors, including Windows junctions; no directory traversal/discovery. */
function checkedPath(full: string, kind: 'file' | 'directory'): NodeIdentity[] {
  absolute(full);
  const root = parse(full).root, parts = full.slice(root.length).split(sep).filter(Boolean);
  if (parts.length > LIMITS.pathDepth) reject();
  let current = root;
  const chain: NodeIdentity[] = [];
  for (const part of [null, ...parts]) {
    if (part !== null) current = join(current, part);
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || (samePath(current, full) && kind === 'file'
      ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()) ||
      !samePath(realpathSync.native(current), current)) reject();
    chain.push({ path: current, stat });
  }
  return chain;
}
function checkChain(before: NodeIdentity[], full: string, kind: 'file' | 'directory'): void {
  const after = checkedPath(full, kind);
  // Directory link counts/timestamps change when our own child is created/removed.
  if (before.length !== after.length || before.some((node, index) =>
    !samePath(node.path, after[index]!.path) || !sameIdentity(node.stat, after[index]!.stat))) reject();
}

interface Pin {
  full: string; fd: number; bytes: number; digest: string; stat: BigIntStats; chain: NodeIdentity[];
}
function readBounded(fd: number, bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, length);
    if (!count) break;
    length += count;
  }
  return buffer.subarray(0, length);
}
function checkPin(pin: Pin): void {
  const before = fstatSync(pin.fd, { bigint: true }), bytes = readBounded(pin.fd, pin.bytes);
  const after = fstatSync(pin.fd, { bigint: true });
  checkChain(pin.chain, pin.full, 'file');
  const named = lstatSync(pin.full, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || !sameFile(pin.stat, before) ||
    !sameFile(before, after) || !sameFile(after, named) ||
    bytes.length !== pin.bytes || sha(bytes) !== pin.digest) reject();
}
function openPin(full: string, limit: number, digest: string): Pin {
  const chain = checkedPath(full, 'file'), named = chain.at(-1)!.stat;
  if (named.size < 1n || named.size > BigInt(limit)) reject();
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!sameFile(named, stat)) reject();
    const pin = { full, fd, bytes: Number(stat.size), digest, stat, chain };
    checkPin(pin);
    return pin;
  } catch { closeSync(fd); throw rejected(); }
}

interface OwnedSource { directory: string; chain: NodeIdentity[]; file?: Pin }
function writeSource(directory: string, bytes: Buffer, owned: OwnedSource): Pin {
  const full = join(directory, 'script.luau');
  const fd = openSync(full, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0), 0o600);
  // Keep ownership immediately, even if a subsequent write/fsync/check fails.
  let pin: Pin;
  try {
    pin = { full, fd, bytes: bytes.length, digest: sha(bytes),
      stat: fstatSync(fd, { bigint: true }), chain: checkedPath(full, 'file') };
  } catch { closeSync(fd); throw rejected(); }
  owned.file = pin;
  if (!pin.stat.isFile() || pin.stat.nlink !== 1n) reject();
  let written = 0;
  while (written < bytes.length) {
    const count = writeSync(fd, bytes, written, bytes.length - written, written);
    if (count < 1) reject();
    written += count;
  }
  fsyncSync(fd);
  const stat = fstatSync(fd, { bigint: true });
  if (!sameIdentity(pin.stat, stat)) reject();
  pin.stat = stat;
  checkPin(pin);
  return pin;
}

/** Exact file unlink and empty directory removal only; never recurse through compiler output. */
function cleanupOwned(owned: OwnedSource, directory: string, chain: NodeIdentity[]): void {
  checkChain(chain, directory, 'directory');
  if (!samePath(dirname(owned.directory), directory)) reject();
  checkChain(owned.chain, owned.directory, 'directory');
  if (owned.file) {
    const pin = owned.file;
    if (!samePath(dirname(pin.full), owned.directory) || basename(pin.full) !== 'script.luau') reject();
    checkChain(pin.chain, pin.full, 'file');
    const named = lstatSync(pin.full, { bigint: true });
    if (!sameIdentity(pin.stat, named) || named.nlink !== 1n ||
      !samePath(realpathSync.native(pin.full), join(realpathSync.native(owned.directory), 'script.luau'))) reject();
    unlinkSync(pin.full);
  }
  checkChain(owned.chain, owned.directory, 'directory');
  rmdirSync(owned.directory);
}

interface ProcessResult { terminal: boolean; code: number | null; signal: string | null; stopped: boolean; stdout: Buffer; stderr: Buffer }
function runCompiler(executable: string, args: string[], cwd: string, deadline: number, signal: AbortSignal): Promise<ProcessResult> {
  return new Promise(resolveResult => {
    let child: ReturnType<typeof childProcess.spawn>;
    const empty = { terminal: true, code: null, signal: null, stopped: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    if (signal.aborted || performance.now() >= deadline) { resolveResult(empty); return; }
    const env: NodeJS.ProcessEnv = {};
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    try {
      child = childProcess.spawn(executable, args, {
        cwd, env, shell: false, windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { resolveResult(empty); return; }
    let done = false, stopped = false, count = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined, termination: ReturnType<typeof setTimeout> | undefined;
    const finish = (terminal: boolean, code: number | null, exitSignal: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(termination); signal.removeEventListener('abort', stop);
      child.stdout?.destroy(); child.stderr?.destroy();
      if (!terminal) child.unref();
      resolveResult({ terminal, code, signal: exitSignal, stopped, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const stop = (): void => {
      if (done || stopped) return;
      stopped = true;
      // Only this ChildProcess. A kill request/exit event does not acknowledge closed pipes.
      termination = setTimeout(() => finish(false, null, null), LIMITS.terminationMs);
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* Await close. */ }
    };
    const receive = (chunks: Buffer[], data: Buffer): void => {
      if (done || stopped) return;
      if (data.length > LIMITS.outputBytes - count) { stop(); return; }
      count += data.length; chunks.push(Buffer.from(data));
    };
    child.stdout?.on('data', data => receive(stdout, data as Buffer));
    child.stderr?.on('data', data => receive(stderr, data as Buffer));
    child.on('error', stop);
    child.stdout?.on('error', stop); child.stderr?.on('error', stop);
    child.once('close', (code, exitSignal) => finish(true, code, exitSignal));
    timer = setTimeout(stop, Math.max(1, deadline - performance.now()));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}
function successful(result: ProcessResult): boolean {
  return result.terminal && !result.stopped && result.code === 0 && result.signal === null && !result.stderr.length;
}
function decode(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function sourceBytes(source: unknown): Buffer {
  if (typeof source !== 'string' || source.length > LIMITS.sourceBytes || !source.trim() ||
    source.includes('\0') || /[\ud800-\udfff]/u.test(source)) reject();
  const bytes = Buffer.from(source, 'utf8');
  if (bytes.length > LIMITS.sourceBytes) reject();
  return bytes;
}
function isAborted(signal: AbortSignal): boolean {
  try {
    const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
    return Reflect.apply(getter, signal, []) as boolean;
  } catch { reject(); }
}

/**
 * Compile-only evidence for the host's sealed activation admission. No interpreter,
 * caller paths/flags, provider environment, cached proof or diagnostic authority.
 * As in the workflow verifier, direct pre/post descriptor and path pins detect observed
 * replacement; this is not an OS sandbox or an immutable filesystem against local races.
 */
export async function createScriptSourceVerifier(options: Options): Promise<ScriptSourceVerifier> {
  let compiler: Pin | undefined;
  try {
    fields(options, ['compiler', 'directory']); fields(options.compiler, ['executablePath', 'sha256']);
    const executable = absolute(options.compiler.executablePath), directory = absolute(options.directory);
    const digest = options.compiler.sha256;
    if (typeof digest !== 'string' || !HASH.test(digest) ||
      basename(executable).toLowerCase() !== (process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile')) reject();
    const directoryChain = checkedPath(directory, 'directory');
    // Reserve the two generated components before creating anything. State privacy
    // on Windows (including its ACL) is a host-constructor prerequisite.
    if (Buffer.byteLength(directory) + 80 > LIMITS.pathBytes || directoryChain.length + 2 > LIMITS.pathDepth + 1) reject();
    const state = directoryChain.at(-1)!.stat;
    if (process.platform !== 'win32' && ((state.mode & 0o077n) !== 0n ||
      (process.getuid && state.uid !== BigInt(process.getuid())))) reject();
    compiler = openPin(executable, LIMITS.compilerBytes, digest);
    const pinnedCompiler = compiler;
    const help = await runCompiler(executable, ['--help'], directory,
      performance.now() + LIMITS.deadlineMs, new AbortController().signal);
    checkPin(pinnedCompiler); checkChain(directoryChain, directory, 'directory');
    if (!successful(help) || !/Usage: [^\r\n]+ \[--mode\] \[options\] \[file list\]/.test(decode(help.stdout)) ||
      !/binary, text, remarks, codegen, codegenir, codegenasm, codegenverbose, codegennull, null/.test(decode(help.stdout))) reject();

    let disposed = false, poisoned = false, active: AbortController | undefined;
    let compilerClosed = false;
    const closeCompiler = (): void => {
      if (!compilerClosed) { compilerClosed = true; closeSync(pinnedCompiler.fd); }
    };
    const verify: ScriptSourceVerifier['verify'] = async (source, signal) => {
      if (disposed || poisoned) reject();
      if (active) throw new Error('Script source verifier is busy.');
      const bytes = sourceBytes(source);
      if (signal !== undefined && (!(signal instanceof AbortSignal) || types.isProxy(signal))) reject();
      if (signal && isAborted(signal)) reject();
      const controller = new AbortController();
      active = controller;
      const cancel = (): void => controller.abort();
      let owned: OwnedSource | undefined, terminal = true;
      const start = performance.now(), deadline = start + LIMITS.deadlineMs;
      const cancelled = (): void => { if (disposed || controller.signal.aborted || performance.now() >= deadline) reject(); };
      const compilerCurrent = (): void => {
        try { checkPin(pinnedCompiler); checkChain(directoryChain, directory, 'directory'); }
        catch { poisoned = true; throw rejected(); }
      };
      let proof: ScriptSourceVerification;
      try {
        if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', cancel, { once: true });
        if (signal && isAborted(signal)) cancel();
        cancelled(); compilerCurrent();
        const childDirectory = join(directory, 'source-verify-' + randomUUID());
        mkdirSync(childDirectory, { mode: 0o700 });
        owned = { directory: childDirectory, chain: checkedPath(childDirectory, 'directory') };
        checkChain(directoryChain, directory, 'directory');
        const file = writeSource(childDirectory, bytes, owned);
        compilerCurrent(); checkPin(file); cancelled();
        const result = await runCompiler(executable, ['--null', file.full], childDirectory, deadline, controller.signal);
        terminal = result.terminal;
        if (!terminal) poisoned = true;
        compilerCurrent(); checkPin(file); cancelled();
        if (!successful(result) || !SUMMARY.test(decode(result.stdout))) reject();
        proof = Object.freeze({ sourceSha256: file.digest, compilerSha256: digest,
          syntaxVerified: true, elapsedMs: performance.now() - start });
      } catch { throw rejected(); }
      finally {
        if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', cancel);
        try {
          if (owned?.file) closeSync(owned.file.fd);
          // Unknown termination retains this exact owned directory as private evidence.
          if (owned && terminal) cleanupOwned(owned, directory, directoryChain);
        } catch { poisoned = true; throw rejected(); }
        finally { active = undefined; if (disposed) closeCompiler(); }
      }
      // Check cancellation and the original compiler pin immediately before publishing proof.
      cancelled(); compilerCurrent();
      return proof;
    };
    return Object.freeze({ verify, dispose(): void {
      if (disposed) return;
      disposed = true; active?.abort();
      if (!active) closeCompiler();
    } });
  } catch {
    if (compiler) closeSync(compiler.fd);
    throw rejected();
  }
}
