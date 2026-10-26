import { AssetError, type AssetFailureDiagnostic } from './types.js';
import type { CommandResult } from './process.js';

// Fixed loader names become diagnostics, never paths, exception text, process
// closure evidence or instructions to download/install a runtime dependency.
const libraries = [
  ['libX11.so.6', 'RUNTIME_LIB_X11'], ['libXrender.so.1', 'RUNTIME_LIB_XRENDER'],
  ['libXfixes.so.3', 'RUNTIME_LIB_XFIXES'], ['libXi.so.6', 'RUNTIME_LIB_XI'],
  ['libXxf86vm.so.1', 'RUNTIME_LIB_XXF86VM'], ['libxkbcommon.so.0', 'RUNTIME_LIB_XKBCOMMON'],
  ['libSM.so.6', 'RUNTIME_LIB_SM'], ['libICE.so.6', 'RUNTIME_LIB_ICE'],
  ['libGL.so.1', 'RUNTIME_LIB_GL'], ['libGLX.so.0', 'RUNTIME_LIB_GLX'],
  ['libEGL.so.1', 'RUNTIME_LIB_EGL'], ['libgomp.so.1', 'RUNTIME_LIB_GOMP'],
  ['libstdc++.so.6', 'RUNTIME_LIB_STDCXX'], ['libc.so.6', 'RUNTIME_LIB_C'],
  ['libwayland-client.so.0', 'RUNTIME_LIB_WAYLAND'],
] as const;
const libraryCodes = new Map<string, string>(libraries);
export const RUNTIME_PROBE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  RUNTIME_PROBE_EXIT: 'Blender exited before returning its required runtime capability report.',
  RUNTIME_PROBE_SIGNAL: 'Blender was stopped by a signal before returning its required runtime capability report.',
  ...Object.fromEntries(libraries.map(([name, code]) => [code, `Blender could not start because the system loader could not find ${name}.`])),
});

/** Describes an observed failed probe; it never proves why an unrelated job
 * failed, that a child closed, that a dependency was installed or retry is safe. */
export function runtimeProbeFailure(result: CommandResult): AssetError {
  let reasonCode = result.signal ? 'RUNTIME_PROBE_SIGNAL' : 'RUNTIME_PROBE_EXIT';
  if (!result.signal && result.exitCode !== 0 && result.stderr.length <= 32768) {
    const reports: string[] = [];
    for (const line of result.stderr.split(/\r?\n/)) {
      const match = /^[^\r\n]{1,4096}: error while loading shared libraries: ([A-Za-z0-9._+-]{1,96}): cannot open shared object file: No such file or directory$/.exec(line);
      if (match) reports.push(match[1]!);
    }
    if (reports.length === 1) reasonCode = libraryCodes.get(reports[0]!) ?? reasonCode;
  }
  const diagnostic: AssetFailureDiagnostic = { schemaVersion: 1, stage: 'probe', reasonCode,
    reason: RUNTIME_PROBE_REASONS[reasonCode]!, exceptionType: null };
  return new AssetError('BLENDER_PROBE', diagnostic.reason, diagnostic);
}
