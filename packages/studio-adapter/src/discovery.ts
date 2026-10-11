import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { win32 } from 'node:path';
import { NativeStudioError } from './policy.js';

export interface NativeStudioExecutable {
  path: string; sha256: string; signer: string; signatureStatus: 'Valid';
  discoveredFrom: 'installed-mcp-launcher';
}
function fail(): never {
  throw new NativeStudioError('STUDIO_EXECUTABLE', 'No vetted official StudioMCP.exe was found. Enable Studio MCP and check the installed Roblox launcher.');
}
/** Parse launcher text as data. Never execute it or its registry fallback. */
export function parseStudioMcpLauncher(contents: string, localAppData: string): string {
  if (Buffer.byteLength(contents, 'utf8') > 16_384 || !win32.isAbsolute(localAppData) || localAppData.startsWith('\\\\')) fail();
  const match = /^\s*if exist "([^"\r\n]+)"\s*\(/im.exec(contents);
  if (!match?.[1]) fail();
  const candidate = win32.normalize(match[1]);
  const versions = win32.join(localAppData, 'Roblox', 'Versions');
  const relative = win32.relative(versions, candidate);
  if (!/^version-[a-f0-9]{16}\\StudioMCP\.exe$/i.test(relative) ||
      !win32.isAbsolute(candidate) || candidate.startsWith('\\\\')) fail();
  return candidate;
}
/** The fixed, encoded signature-check script receives a path as data in one environment variable. */
const signatureScript = [
  "$ErrorActionPreference = 'Stop'",
  '$signature = Get-AuthenticodeSignature -LiteralPath $env:ARCANE_STUDIO_SIGNATURE_PATH',
  '@{status = [string]$signature.Status; signer = [string]$signature.SignerCertificate.Subject} | ConvertTo-Json -Compress',
].join('\n');
export async function discoverNativeStudioExecutable(): Promise<NativeStudioExecutable> {
  if (process.platform !== 'win32') throw new NativeStudioError('STUDIO_PLATFORM', 'Native Studio discovery currently supports the installed Windows Studio MCP executable.');
  const localAppData = process.env.LOCALAPPDATA, systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!localAppData || !systemRoot || !win32.isAbsolute(localAppData) || !win32.isAbsolute(systemRoot)) fail();
  const roblox = win32.join(localAppData, 'Roblox');
  const launcher = win32.join(roblox, 'mcp.bat');
  try {
    const launcherStat = await lstat(launcher);
    if (!launcherStat.isFile() || launcherStat.isSymbolicLink() || launcherStat.size > 16_384) fail();
    const path = parseStudioMcpLauncher(await readFile(launcher, 'utf8'), localAppData);
    // Reject junctions/symlinks rather than vetting one path and executing another.
    for (const directory of [localAppData, roblox, win32.join(roblox, 'Versions'), win32.dirname(path), path]) {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || win32.normalize(await realpath(directory)).toLowerCase() !== win32.normalize(directory).toLowerCase()) fail();
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size < 2 || stat.size > 100 * 1024 * 1024) fail();
    const handle = await open(path, 'r');
    try { const magic = Buffer.alloc(2); await handle.read(magic, 0, 2, 0); if (magic.toString('ascii') !== 'MZ') fail(); }
    finally { await handle.close(); }
    const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const signature = await new Promise<{ status: string; signer: string }>((resolve, reject) => {
      execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(signatureScript, 'utf16le').toString('base64')], {
        shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 16_384, encoding: 'utf8',
        env: { SystemRoot: systemRoot, LOCALAPPDATA: localAppData, ARCANE_STUDIO_SIGNATURE_PATH: path },
      }, (error, stdout) => {
        if (error) return reject(new NativeStudioError('STUDIO_SIGNATURE', 'Official Studio executable signature verification failed.'));
        try { resolve(JSON.parse(stdout) as { status: string; signer: string }); }
        catch { reject(new NativeStudioError('STUDIO_SIGNATURE', 'Official Studio executable signature verification failed.')); }
      });
    });
    if (signature.status !== 'Valid' || typeof signature.signer !== 'string' ||
        !/(?:^|,\s*)CN=Roblox Corporation(?:,|$)/i.test(signature.signer) ||
        !/(?:^|,\s*)O=Roblox Corporation(?:,|$)/i.test(signature.signer)) fail();
    const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
    return { path, sha256, signer: signature.signer, signatureStatus: 'Valid', discoveredFrom: 'installed-mcp-launcher' };
  } catch (error) { if (error instanceof NativeStudioError) throw error; return fail(); }
}
