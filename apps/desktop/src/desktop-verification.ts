/// <reference lib="dom" />

/** Native metadata only. A saved configuration is not verification evidence. */
export interface DesktopVerificationState {
  readonly version: 1;
  readonly projectId: string;
  readonly configured: boolean;
  readonly pendingRestart: boolean;
  readonly evidenceDirectory: string | null;
  readonly cancelled: boolean;
}
export interface DesktopVerificationNativeBridge {
  readonly version: 1;
  status(): Promise<DesktopVerificationState>;
  configure(): Promise<DesktopVerificationState>;
}
export interface DesktopVerificationOptions {
  /** Canonical product metadata from the trusted controller, never a DOM input. */
  getProjectId(): string | null;
  /** Synchronous invalidation, including changes away and back to the same ID. */
  subscribeProjectChange(invalidate: () => void): () => void;
  /** Explicit fixture/host adapter; otherwise read the native window descriptor. */
  nativeBridge?: unknown;
}
export interface DesktopVerificationController {
  stop(): void;
  resume(): void;
  cleanup(): void;
}

export const DESKTOP_VERIFICATION_DIRECTORY_BYTES = 245;
const PRIVATE_DIRECTORY = new Set(['.git', '.codex', '.claude', '.claude-code', '.agents', '.aws', '.ssh', '.azure', '.env', '.config', '.arcane',
  '.arcane-private-receipts-v1', 'workflow-human-receipts', 'native-codex', '.gnupg', '.kube', '.npm', '.docker', '.pki', '.vscode', '.idea',
  'node_modules', 'config', 'credentials', 'secrets', '.credentials', '.secrets', 'runtime', '.runtime']);
const PRIVATE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.gitconfig|\.git-credentials|\.claude\.json|\.codexrc|auth\.json|credentials(?:\.json)?|secrets(?:\.json)?|tokens?\.json|key-v1|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|config\.toml)$/i;
const PRIVATE_EXTENSION = /\.(?:pem|key|p12|pfx|jks|kdbx|sqlite(?:3)?(?:-wal|-shm|-journal)?)$/i;
const HASH = /^[a-f0-9]{64}$/;
const projectHash = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 64 && HASH.test(value);
type Data = Record<string, unknown>;

/** Inspect data descriptors without evaluating accessors or serializing objects. */
function exactData(value: unknown, keys: readonly string[], frozen = false): Data | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const names = Reflect.ownKeys(value);
    if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy: Data = Object.create(null) as Data;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      copy[key] = descriptor.value;
    }
    if (frozen && !Object.isFrozen(value)) return null;
    return copy;
  } catch { return null; } // Revoked/throwing proxies are unavailable.
}
function ownData(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function nativeBridge(doc: Document, options: DesktopVerificationOptions): DesktopVerificationNativeBridge | null {
  try {
    const supplied = Object.getOwnPropertyDescriptor(options, 'nativeBridge');
    const candidate = supplied
      ? ('value' in supplied ? supplied.value : undefined)
      : ownData(ownData(doc.defaultView, 'arcaneDesktop'), 'codeVerification');
    const data = exactData(candidate, ['version', 'status', 'configure'], true);
    if (!data || data.version !== 1 || typeof data.status !== 'function' || typeof data.configure !== 'function') return null;
    // Capture the frozen own methods once. Construction never invokes either.
    return Object.freeze({
      version: 1,
      status: () => Reflect.apply(data.status as DesktopVerificationNativeBridge['status'], candidate, []),
      configure: () => Reflect.apply(data.configure as DesktopVerificationNativeBridge['configure'], candidate, []),
    });
  } catch { return null; }
}
function relativeDirectory(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFKC') || value.includes('\\') || value.trim() !== value ||
      new TextEncoder().encode(value).byteLength > DESKTOP_VERIFICATION_DIRECTORY_BYTES ||
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value) ||
      /[\ud800-\udfff]/u.test(value)) return false;
  // Canonical host metadata for display only; never resolve or open this path.
  return !value.split('/').some(part => !part || part === '.' || part === '..' ||
    /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || PRIVATE_DIRECTORY.has(part.toLowerCase()) || PRIVATE_FILE.test(part) || PRIVATE_EXTENSION.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function readState(value: unknown, projectId: string, action: 'status' | 'configure'): DesktopVerificationState {
  const data = exactData(value, ['version', 'projectId', 'configured', 'pendingRestart', 'evidenceDirectory', 'cancelled']);
  if (!data || data.version !== 1 || !projectHash(data.projectId) || data.projectId !== projectId ||
      typeof data.configured !== 'boolean' || typeof data.pendingRestart !== 'boolean' ||
      typeof data.cancelled !== 'boolean' || (action === 'status' && data.cancelled) ||
      !(data.evidenceDirectory === null || relativeDirectory(data.evidenceDirectory)) ||
      (data.configured ? data.evidenceDirectory === null : data.evidenceDirectory !== null)) {
    throw new Error('Desktop setup unavailable.');
  }
  return Object.freeze({
    version: 1, projectId: data.projectId, configured: data.configured,
    pendingRestart: data.pendingRestart, evidenceDirectory: data.evidenceDirectory, cancelled: data.cancelled,
  });
}

/** Mount listeners only; both zero-argument native calls require a trusted click.
 * Native buttons provide Enter/Space activation. No process checks, HTTP or retries.
 */
export function startDesktopVerification(doc: Document, options: DesktopVerificationOptions): DesktopVerificationController {
  const root = doc.getElementById('desktop-verification');
  const status = doc.getElementById('desktop-verification-status');
  const notice = doc.getElementById('desktop-verification-notice');
  const evidence = doc.getElementById('desktop-verification-evidence');
  const setup = doc.getElementById('desktop-verification-setup') as HTMLButtonElement | null;
  const refresh = doc.getElementById('desktop-verification-refresh') as HTMLButtonElement | null;
  if (!root || !status || !notice || !evidence || !setup || !refresh) {
    return { stop() {}, resume() {}, cleanup() {} };
  }
  const bridge = nativeBridge(doc, options);
  let running = false, disposed = false, busy = false, needsRefresh = false;
  let projectId: string | null = null, generation = 0;
  let state: DesktopVerificationState | null = null;
  let removeProject: (() => void) | null = null;

  const render = (): void => {
    root.setAttribute('aria-busy', String(busy));
    refresh.disabled = !running || disposed || busy || !bridge || !projectId;
    setup.disabled = refresh.disabled || needsRefresh;
    evidence.textContent = state?.evidenceDirectory ? 'Evidence folder: ' + state.evidenceDirectory : '';
    evidence.hidden = !state?.evidenceDirectory;
    if (!bridge) status.textContent = 'CLI-only: desktop setup is unavailable here.';
    else if (!running) status.textContent = 'Setup view paused. Refresh setup status after returning.';
    else if (!projectId) status.textContent = 'Project identity unavailable. Refresh the current project metadata.';
    else if (needsRefresh) status.textContent = 'Desktop setup is unavailable. Refresh setup status explicitly.';
    else if (!state) status.textContent = 'Setup status has not been read for this project.';
    else if (state.pendingRestart) status.textContent = state.configured
      ? 'Configuration saved for this project. It applies after the next manual restart.'
      : 'No configuration is recorded for this project. A manual restart is pending.';
    else status.textContent = state.configured
      ? 'Configuration is recorded for this project. Compiler readiness has not been checked.'
      : 'No Luau verification configuration is saved for this project.';
  };
  const syncProject = (force = false): void => {
    let next: string | null = null;
    try { const value = options.getProjectId(); if (projectHash(value)) next = value; } catch { /* Unavailable metadata. */ }
    if (!force && next === projectId) return;
    projectId = next; generation++; state = null; needsRefresh = false;
    notice.textContent = ''; render();
  };
  const current = (epoch: number, id: string): boolean => {
    syncProject();
    return running && !disposed && generation === epoch && projectId === id;
  };
  const run = async (action: 'status' | 'configure'): Promise<void> => {
    syncProject();
    if (!running || disposed || busy || !bridge || !projectId || (action === 'configure' && needsRefresh)) return;
    const id = projectId, epoch = generation;
    busy = true; notice.textContent = action === 'configure'
      ? 'Choose the approved Luau binary and evidence folder in the native dialogs.'
      : 'Reading saved setup metadata.'; render();
    try {
      const value = await bridge[action]();
      if (!current(epoch, id)) return;
      const next = readState(value, id, action);
      if (next.cancelled) {
        notice.textContent = state ? 'Setup cancelled. Previous observed status retained.'
          : 'Setup cancelled. Refresh setup status to read the project configuration.';
      } else {
        state = next; needsRefresh = false;
        notice.textContent = action === 'configure'
          ? 'Setup response recorded. Configuration is not compiler readiness or workflow completion.' : '';
      }
    } catch {
      // Never render host error text, which may include absolute paths or secrets.
      if (current(epoch, id)) {
        state = null; needsRefresh = true;
        notice.textContent = action === 'configure'
          ? 'Setup outcome is unavailable. Refresh setup status before trying again.'
          : 'Setup status is unavailable. Refresh explicitly to try again.';
      }
    } finally {
      busy = false;
      if (running && !disposed) { syncProject(); render(); }
    }
  };
  const removers: (() => void)[] = [];
  for (const [button, action] of [[refresh, 'status'], [setup, 'configure']] as const) {
    const clicked: EventListener = event => {
      const input = event as MouseEvent;
      if (event.isTrusted !== true || event.defaultPrevented || event.type !== 'click' ||
          (input.button !== undefined && input.button !== 0) || input.altKey || input.ctrlKey ||
          input.metaKey || input.shiftKey || button.disabled) return;
      event.preventDefault();
      void run(action);
    };
    const keyGuard: EventListener = event => {
      const key = event as KeyboardEvent;
      if ((key.key === 'Enter' || key.key === ' ') &&
          (event.isTrusted !== true || key.repeat || key.altKey || key.ctrlKey || key.metaKey || key.shiftKey)) event.preventDefault();
    };
    button.addEventListener('click', clicked); button.addEventListener('keydown', keyGuard);
    removers.push(() => { button.removeEventListener('click', clicked); button.removeEventListener('keydown', keyGuard); });
  }
  const stop = (): void => {
    if (disposed) return;
    running = false; generation++; state = null; needsRefresh = false; notice.textContent = '';
    removeProject?.(); removeProject = null; render();
    // Keep an unresolved native call in flight across pagehide; it cannot be aborted.
  };
  const resume = (): void => {
    if (disposed || running) return;
    running = true; syncProject(true);
    if (bridge) {
      try { removeProject = options.subscribeProjectChange(() => { if (running && !disposed) syncProject(true); }); }
      catch { projectId = null; generation++; render(); }
    }
    render();
  };
  resume();
  return {
    stop, resume,
    cleanup() { stop(); disposed = true; for (const remove of removers) remove(); },
  };
}
