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
  RUNTIME_NOT_FOUND: 'No eligible installed Blender executable was discovered.',
  RUNTIME_PROCESS_START: 'The operating system could not start the discovered Blender executable.',
  RUNTIME_PROCESS_PATH: 'The Blender executable or working directory failed its absolute native path check.',
  RUNTIME_PROCESS_LIMIT: 'The runtime probe was refused because its process limits were invalid.',
  RUNTIME_PROCESS_OUTPUT: 'The runtime probe exceeded its bounded output limit.',
  RUNTIME_PROCESS_IDENTITY: 'The running runtime probe could not be safely recorded and was stopped.',
  RUNTIME_PROBE_INVALID: 'Blender did not return a valid runtime capability report.',
  RUNTIME_PROBE_FAILED: 'The runtime probe failed before usable capability evidence was available.',
  RUNTIME_CAPABILITY_GLB_EXPORT: 'The installed Blender did not expose the required GLB export operator.',
  RUNTIME_CAPABILITY_GLB_IMPORT: 'The installed Blender did not expose the required GLB import operator.',
  RUNTIME_CAPABILITY_FBX_EXPORT: 'The installed Blender did not expose the required FBX export operator.',
  RUNTIME_CAPABILITY_FBX_IMPORT: 'The installed Blender did not expose the required FBX import operator.',
  RUNTIME_CAPABILITY_CYCLES: 'The installed Blender did not expose the required Cycles render engine.',
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

export function runtimeProbeDiagnostic(reasonCode: string): AssetFailureDiagnostic {
  if (!Object.hasOwn(RUNTIME_PROBE_REASONS, reasonCode)) throw new Error('Unknown fixed runtime probe reason.');
  return { schemaVersion: 1, stage: 'probe', reasonCode, reason: RUNTIME_PROBE_REASONS[reasonCode]!, exceptionType: null };
}

export function missingRuntimeCapability(capabilities: Record<string, unknown>): AssetFailureDiagnostic | null {
  for (const [key, reason] of [
    ['glbExport', 'RUNTIME_CAPABILITY_GLB_EXPORT'], ['glbImport', 'RUNTIME_CAPABILITY_GLB_IMPORT'],
    ['fbxExport', 'RUNTIME_CAPABILITY_FBX_EXPORT'], ['fbxImport', 'RUNTIME_CAPABILITY_FBX_IMPORT'], ['cycles', 'RUNTIME_CAPABILITY_CYCLES'],
  ] as const) if (capabilities[key] !== true) return runtimeProbeDiagnostic(reason);
  return null;
}

/** Exception messages/paths are never projected. These codes describe failed
 * discovery/start/validation, not a missing library or observed child closure. */
export function runtimeProbeException(error: unknown): AssetFailureDiagnostic {
  if (error instanceof AssetError && error.diagnostic && Object.hasOwn(RUNTIME_PROBE_REASONS, error.diagnostic.reasonCode) &&
      error.diagnostic.stage === 'probe' && error.diagnostic.exceptionType === null) return runtimeProbeDiagnostic(error.diagnostic.reasonCode);
  const reasons: Readonly<Record<string, string>> = {
    PROCESS_START: 'RUNTIME_PROCESS_START', PROCESS_PATH: 'RUNTIME_PROCESS_PATH', PROCESS_LIMIT: 'RUNTIME_PROCESS_LIMIT',
    PROCESS_OUTPUT: 'RUNTIME_PROCESS_OUTPUT', SUPERVISION_UNRECORDED: 'RUNTIME_PROCESS_IDENTITY',
    WORKER_PROTOCOL: 'RUNTIME_PROBE_INVALID', BLENDER_PROBE: 'RUNTIME_PROBE_INVALID',
  };
  return runtimeProbeDiagnostic(error instanceof AssetError && Object.hasOwn(reasons, error.code) ? reasons[error.code]! : 'RUNTIME_PROBE_FAILED');
}
