import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, win32, posix } from 'node:path';
import { access, opendir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { ArcaneError } from '../../protocol/src/providers.js';

interface NativeCliFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; mode: number }>;
  access(path: string, mode: number): Promise<void>;
  opendir(path: string): Promise<AsyncIterable<{ name: string; isDirectory(): boolean }>>;
}
export interface NativeCliResolverOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  homedir?: () => string;
  fs?: NativeCliFileSystem;
}
const PATH_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/** Trusted host/test seam only; never construct these options from a request. */
export function createNativeCliResolver(options: NativeCliResolverOptions = {}) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const p = platform === 'win32' ? win32 : posix;
  const fs = options.fs ?? { access, opendir, realpath, stat };
  const home = options.homedir ?? homedir;
  function absolute(value: unknown): string {
    if (typeof value !== 'string' || !value || value !== value.trim() || PATH_CONTROL.test(value) ||
        Buffer.byteLength(value) > 2048 || !p.isAbsolute(value)) throw new Error('Invalid executable path.');
    if (platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || /[<>"|?*]/.test(value) || value.slice(2).includes(':') ||
        value.split(/[\\/]/).slice(1).some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
      throw new Error('Invalid executable path.');
    }
    return p.normalize(value);
  }
  function pathDirectories(env: NodeJS.ProcessEnv): string[] {
    const raw = env.PATH ?? env.Path ?? '';
    if (typeof raw !== 'string' || raw.length > 32768) return [];
    const entries = raw.split(p.delimiter);
    if (entries.length > 64) return [];
    const directories = new Map<string, string>();
    for (let entry of entries) {
      if (entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
      try {
        const full = absolute(entry), key = platform === 'win32' ? full.toLowerCase() : full;
        if (!directories.has(key)) directories.set(key, full);
      } catch { /* Ignore empty, relative, control, device and network paths. */ }
    }
    return [...directories.values()];
  }
  return async (name: 'codex' | 'claude', env = process.env): Promise<string | null> => {
    if (name !== 'codex' && name !== 'claude') return null;
    const filename = name + (platform === 'win32' ? '.exe' : '');
    const candidate = async (value: string): Promise<string | null> => {
      try {
        const input = absolute(value), full = absolute(await fs.realpath(input));
        const info = await fs.stat(full);
        if (!info.isFile() || (platform !== 'win32' && !(info.mode & 0o111)) ||
            (platform === 'win32' && p.basename(full).toLowerCase() !== filename)) return null;
        await fs.access(full, constants.X_OK);
        return full;
      } catch { return null; }
    };
    const directories = pathDirectories(env);
    for (const directory of directories) {
      const full = await candidate(p.join(directory, filename));
      if (full) return full;
    }
    // Fixed official native user locations, without reading provider config/auth.
    try {
      const full = await candidate(p.join(absolute(home()), '.local', 'bin', filename));
      if (full) return full;
    } catch { /* An invalid home cannot supply a candidate. */ }
    if (name === 'codex' && platform === 'win32' && env.LOCALAPPDATA) {
      let directory: AsyncIterable<{ name: string; isDirectory(): boolean }> | undefined;
      let root: string | undefined;
      try {
        root = absolute(p.join(absolute(env.LOCALAPPDATA), 'OpenAI', 'Codex', 'bin'));
        directory = await fs.opendir(root);
      } catch { /* An absent native install may still have an npm payload. */ }
      if (directory && root) {
        let found: string | null = null, count = 0;
        try {
          for await (const entry of directory) {
            // Read a 33rd sentinel only to detect overflow; never inspect its path.
            if (++count > 32) return null;
            if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
            const full = await candidate(p.join(root, entry.name, filename));
            if (full) {
              if (found) return null;
              found = full;
            }
          }
        } catch { return null; } // Do not accept a partial or ambiguous inventory.
        if (found) return found;
      }
    }
    // Fixed npm native payloads only: no .cmd/.ps1/JS shim or npm invocation.
    if (name === 'codex' && platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
      const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
      for (const directory of directories) {
        const packageRoot = p.join(directory, 'node_modules', '@openai');
        for (const root of [p.join(packageRoot, 'codex', 'node_modules', '@openai', 'codex-win32-' + arch),
          p.join(packageRoot, 'codex-win32-' + arch), p.join(packageRoot, 'codex')]) {
          const full = await candidate(p.join(root, 'vendor', triple, 'codex', 'codex.exe'));
          if (full) return full;
        }
      }
    }
    return null;
  };
}
const nativeCliResolver = createNativeCliResolver();
export async function locateNativeCli(name: 'codex' | 'claude', env = process.env): Promise<string | null> {
  return nativeCliResolver(name, env);
}
export interface ProcessSpec { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
export function spawnNative(spec: ProcessSpec): ChildProcessWithoutNullStreams {
  if (!isAbsolute(spec.command) || !isAbsolute(spec.cwd)) throw new ArcaneError('PROCESS_PATH', 'Executable and workspace must be absolute.');
  return spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env ?? process.env, shell: false, windowsHide: true, stdio: 'pipe' });
}
export async function boundedCommand(spec: ProcessSpec, timeoutMs = 8000, maxBytes = 131072): Promise<{ stdout: string; exitCode: number | null }> {
  const child = spawnNative(spec);
  return new Promise((resolve, reject) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: ArcaneError, code: number | null = null) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode: code });
    };
    const timer = setTimeout(() => finish(new ArcaneError('PROCESS_TIMEOUT', 'Native CLI probe timed out.')), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) return finish(new ArcaneError('PROCESS_LIMIT', 'Native CLI output exceeded its bound.'));
      chunks.push(chunk);
    });
    // Never log raw stderr: it may include account or local configuration details.
    child.stderr.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) finish(new ArcaneError('PROCESS_LIMIT', 'Native CLI output exceeded its bound.'));
    });
    child.on('error', () => finish(new ArcaneError('PROCESS_FAILED', 'Native CLI could not start.')));
    child.on('close', code => finish(undefined, code));
    child.stdin.end();
  });
}

