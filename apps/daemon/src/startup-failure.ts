/** Fixed startup-failure vocabulary for the private launcher IPC channel.
 * Only a code crosses the boundary: never stderr, paths, exception text or secrets. */
export const STARTUP_FAILURE_CODES = Object.freeze(['PORT_IN_USE', 'STATE_NEWER', 'STATE_UNSAFE', 'RESOURCE_UNAVAILABLE', 'STARTUP_FAILED'] as const);
export type StartupFailureCode = typeof STARTUP_FAILURE_CODES[number];
export type StartupPhase = 'resources' | 'state' | 'services' | 'listen' | 'descriptor';
export interface StartupFailureMessage { type: 'arcane-startup-failure'; protocolVersion: 1; code: StartupFailureCode }

// Fixed store refusals for state written by a later schema (studio, work, workflow,
// conversation-work, learning, native journal and task stores).
const NEWER_STATE = /\bnewer than this (?:Arcane )?build\b/;

export function classifyStartupFailure(phase: StartupPhase, error: unknown): StartupFailureCode {
  const value = error && typeof error === 'object' ? error as { code?: unknown; syscall?: unknown; message?: unknown } : {};
  // Only a proved listener bind conflict is reported as a port conflict.
  if (phase === 'listen' && value.code === 'EADDRINUSE' && value.syscall === 'listen') return 'PORT_IN_USE';
  if (typeof value.message === 'string' && NEWER_STATE.test(value.message)) return 'STATE_NEWER';
  if (phase === 'state') return 'STATE_UNSAFE';
  if (phase === 'resources') return 'RESOURCE_UNAVAILABLE';
  return 'STARTUP_FAILED';
}

export function startupFailureMessage(code: StartupFailureCode): StartupFailureMessage {
  if (!STARTUP_FAILURE_CODES.includes(code)) throw new Error('Unknown startup failure code.');
  return { type: 'arcane-startup-failure', protocolVersion: 1, code };
}

type Send = (message: StartupFailureMessage, callback: (error: Error | null) => void) => boolean;

/** Best-effort, bounded report to a connected private parent. The caller still
 * rethrows the original error, so its exit status and diagnostics are unchanged. */
export async function reportStartupFailure(phase: StartupPhase, error: unknown,
  channel: { send?: Send | undefined; connected?: boolean } = process as unknown as { send?: Send; connected?: boolean }, deadlineMs = 2000): Promise<StartupFailureCode> {
  const code = classifyStartupFailure(phase, error);
  const send = channel.send;
  if (typeof send !== 'function' || channel.connected !== true) return code;
  await new Promise<void>(resolve => {
    // Deliberately referenced: an unref'd fallback could let Node exit on an unsettled
    // top-level await before the original startup error is rethrown.
    const timer = setTimeout(resolve, deadlineMs);
    const done = () => { clearTimeout(timer); resolve(); };
    try { send.call(channel, startupFailureMessage(code), done); } catch { done(); }
  });
  return code;
}
