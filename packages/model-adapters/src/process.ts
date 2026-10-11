import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join, delimiter } from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { ArcaneError } from '../../protocol/src/providers.js';

export async function locateNativeCli(name: 'codex' | 'claude', env = process.env): Promise<string | null> {
  const filename = process.platform === 'win32' ? name + '.exe' : name;
  for (const entry of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, '');
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, filename);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  return null;
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

