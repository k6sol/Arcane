import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AssetError } from './types.js';

export interface CommandSpec { executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
export interface CommandOptions { signal?: AbortSignal; deadlineMs?: number; maxOutputBytes?: number; onLine?: (line: string) => void }
export interface CommandResult { stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }

/** Intentionally excludes provider credentials, user Python paths and Blender overrides. */
export function workerEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'PATH', 'Path', 'PATHEXT', 'LD_LIBRARY_PATH']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, TEMP: directory, TMP: directory, TMPDIR: directory, HOME: directory, USERPROFILE: directory,
    BLENDER_USER_CONFIG: directory, BLENDER_USER_SCRIPTS: directory, BLENDER_USER_EXTENSIONS: directory,
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
}

/** No shell or detached process. Bundled workers never launch child processes. */
export function runBounded(spec: CommandSpec, options: CommandOptions = {}): Promise<CommandResult> {
  if (!isAbsolute(spec.executable) || !isAbsolute(spec.cwd) || /\.(?:bat|cmd|ps1)$/i.test(spec.executable)) {
    throw new AssetError('PROCESS_PATH', 'An absolute native executable and working directory are required.');
  }
  const deadlineMs = options.deadlineMs ?? 10000, limit = options.maxOutputBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 600000 || !Number.isSafeInteger(limit) || limit < 128 || limit > 4 * 1024 * 1024) {
    throw new AssetError('PROCESS_LIMIT', 'Invalid process deadline or output limit.');
  }
  if (options.signal?.aborted) return Promise.reject(new AssetError('CANCELLED', 'Operation cancelled before launch.'));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env ?? workerEnvironment(spec.cwd),
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, stopped: AssetError | undefined;
    const decoder = new StringDecoder('utf8'); let pending = '';
    const out: Buffer[] = [], err: Buffer[] = [];
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: AssetError) => {
      if (stopped) return;
      stopped = error; child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 500);
    };
    const abort = () => stop(new AssetError('CANCELLED', 'Operation cancelled.'));
    const timer = setTimeout(() => stop(new AssetError('DEADLINE', 'Worker exceeded its deadline.')), deadlineMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) stop(new AssetError('PROCESS_OUTPUT', 'Worker exceeded the combined output limit.'));
      else if (!stopped) chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      collect(out, chunk); if (stopped || !options.onLine) return;
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
        try { options.onLine(line); } catch { /* observers cannot interrupt supervision */ }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => collect(err, chunk));
    child.once('error', () => { stopped ??= new AssetError('PROCESS_START', 'Native worker could not start.'); });
    // Do not release the supervisor slot until close: timeout/cancellation waits for process exit.
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer); if (force) clearTimeout(force); options.signal?.removeEventListener('abort', abort);
      if (stopped) reject(stopped);
      else resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode, signal });
    });
  });
}
