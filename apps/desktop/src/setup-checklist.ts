/// <reference lib="dom" />
// First-run setup checklist and the Settings Studio plugin card. Every check reads existing local state only:
// provider sign-in evidence, the native plugin file status, reported Studio sessions and the open project.
// Nothing here starts a model call, a Studio command or a write without an explicit click.

export type ChecklistStep = 'provider' | 'plugin' | 'studio' | 'project';
export type ChecklistState = 'done' | 'todo' | 'checking' | 'unavailable';
export type PluginInstallState = 'installed' | 'outdated' | 'missing' | 'unavailable';
export type ChecklistAction = 'sign-in' | 'install-plugin' | 'check-plugin' | 'show-key' | 'open-project' | 'connect-studio' | 'review-studio';
/** Two-sided pairing state (studio-key-settings.ts StudioPairing). Display data only: a phase, the 6-digit code and a message. */
export interface ChecklistPairing { phase: 'idle' | 'starting' | 'waiting' | 'busy' | 'approval' | 'approved' | 'claimed' | 'expired' | 'failed' | 'error'; code: string | null; message: string }

export interface PluginStatus { state: PluginInstallState; pluginVersion: string | null; message: string }
export interface ChecklistSignals {
  /** Fresh provider sign-in evidence; never inferred from saved preferences. */
  signedIn: boolean;
  providerName: 'ChatGPT' | 'Claude' | 'Arcane';
  /** Null while the first native read is pending. */
  plugin: PluginStatus | null;
  /** Desktop app bridge present: plugin install and project picker are available. */
  desktop: boolean;
  /** Null before the first Studio session read. */
  studioConnected: boolean | null;
  /** Null until the daemon reports the open project. */
  projectPath: string | null;
  /** Present only when one-click pairing is available; absent keeps the API key flow. */
  pairing?: ChecklistPairing | null;
}
export interface ChecklistRow { step: ChecklistStep; label: string; detail: string; state: ChecklistState; action: { kind: ChecklistAction; label: string } | null }
export interface ChecklistMemory { version: 1; completed: boolean; dismissed: boolean }

export const SETUP_CHECKLIST_KEY = 'arcane.setup-checklist.v1';
export const PLUGIN_MESSAGES = Object.freeze({
  checking: 'Checking the Studio plugin…',
  desktop: 'Install the plugin from the Arcane desktop app.',
  failed: 'Studio plugin setup is unavailable.',
});
const VERSION = /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/;
const STATES: readonly PluginInstallState[] = ['installed', 'outdated', 'missing', 'unavailable'];

/** The default per-user starter folder (…/projects/Untitled) that Arcane opens when no project was chosen. */
export function isStarterProject(path: string): boolean { return /(?:^|[\\/])projects[\\/]Untitled[\\/]?$/i.test(path); }
const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/** Pure: the four checklist rows for the observed signals. */
export function checklistRows(s: ChecklistSignals): ChecklistRow[] {
  const plugin: ChecklistRow = (() => {
    const base = { step: 'plugin' as const, label: 'Studio plugin installed' };
    if (!s.desktop) return { ...base, state: 'unavailable', detail: PLUGIN_MESSAGES.desktop, action: null };
    if (!s.plugin) return { ...base, state: 'checking', detail: PLUGIN_MESSAGES.checking, action: null };
    const version = s.plugin.pluginVersion ? ' Version ' + s.plugin.pluginVersion + '.' : '';
    if (s.plugin.state === 'installed') return { ...base, state: 'done', detail: 'Installed and current.' + version, action: null };
    if (s.plugin.state === 'outdated') return { ...base, state: 'todo', detail: 'An older version is installed.', action: { kind: 'install-plugin', label: 'Update plugin' } };
    if (s.plugin.state === 'missing') return { ...base, state: 'todo', detail: 'Add the Arcane plugin to Roblox Studio.', action: { kind: 'install-plugin', label: 'Install plugin' } };
    return { ...base, state: 'unavailable', detail: s.plugin.message, action: { kind: 'check-plugin', label: 'Check again' } };
  })();
  return [
    s.signedIn
      ? { step: 'provider', label: 'Signed in', detail: s.providerName === 'Arcane' ? 'Using Arcane Credits.' : 'Using your ' + s.providerName + ' account.', state: 'done', action: null }
      : { step: 'provider', label: 'Sign in', detail: 'Use a ChatGPT or Claude subscription, or Arcane Credits.', state: 'todo', action: { kind: 'sign-in', label: 'Sign in' } },
    plugin,
    s.studioConnected === true
      ? { step: 'studio', label: 'Studio connected', detail: 'A live Studio session is paired.', state: 'done', action: null }
      // In order: Studio can only connect through the plugin, so a missing plugin comes first.
      : s.desktop && s.plugin?.state === 'missing' && (!s.pairing || s.pairing.phase === 'idle')
      ? { step: 'studio', label: 'Connect Studio', detail: 'Install the plugin first. Then connect Studio here with a 6-digit code.', state: 'todo', action: null }
      : s.pairing ? studioPairingRow(s.studioConnected, s.pairing)
      : { step: 'studio', label: 'Connect Studio', detail: s.studioConnected === null ? 'Checking for a Studio session…' : 'Paste an Arcane API key into the plugin in Studio (one-click Connect Studio is unavailable here).',
        state: s.studioConnected === null ? 'checking' : 'todo', action: { kind: 'show-key', label: 'Use API key' } },
    s.projectPath
      ? { step: 'project', label: 'Project open', detail: isStarterProject(s.projectPath) ? 'Starter project. Open your own folder anytime.' : folderName(s.projectPath), state: 'done', action: null }
      : { step: 'project', label: 'Open a project', detail: s.desktop ? 'Choose the folder for your game.' : 'Open a project from the Arcane desktop app.', state: 'todo',
        action: s.desktop ? { kind: 'open-project', label: 'Open project' } : null },
  ];
}

/** Studio row with one-click pairing: Connect Studio here, then one click in the plugin. The API key stays a fallback. */
function studioPairingRow(connected: boolean | null, pairing: ChecklistPairing): ChecklistRow {
  const base = { step: 'studio' as const, label: 'Connect Studio' };
  const fallback = { kind: 'show-key' as const, label: 'Use API key' };
  if (pairing.phase === 'waiting' && pairing.code) return { ...base, state: 'todo', detail: 'Waiting for Studio… In Roblox Studio, type ' + (pairing.code.length === 6 ? pairing.code.slice(0, 3) + ' ' + pairing.code.slice(3) : pairing.code) + ' into the Arcane plugin and click Connect.', action: fallback };
  // Approve/Deny live on the Studio plugin card in Settings, next to the place name and ID.
  if (pairing.phase === 'approval') return { ...base, state: 'todo', detail: pairing.message, action: { kind: 'review-studio', label: 'Review request' } };
  if (pairing.phase === 'approved') return { ...base, state: 'checking', detail: pairing.message, action: null };
  if (pairing.phase === 'starting') return { ...base, state: 'checking', detail: 'Preparing a Studio connection…', action: null };
  if (pairing.phase === 'busy' || pairing.phase === 'error') return { ...base, state: 'todo', detail: pairing.message, action: fallback };
  if (connected === null) return { ...base, state: 'checking', detail: 'Checking for a Studio session…', action: { kind: 'connect-studio', label: 'Connect Studio' } };
  const detail = pairing.phase === 'expired' || pairing.phase === 'failed' ? pairing.message
    : pairing.phase === 'claimed' ? 'Studio paired. Waiting for its first heartbeat…' : 'Click Connect Studio, then type its code into the Arcane plugin.';
  return { ...base, state: 'todo', detail, action: { kind: 'connect-studio', label: 'Connect Studio' } };
}

/** Bounded, exact memory record; anything else reads as a first run. */
export function readChecklistMemory(raw: unknown): ChecklistMemory {
  const empty: ChecklistMemory = { version: 1, completed: false, dismissed: false };
  if (typeof raw !== 'string' || raw.length > 128) return empty;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return empty;
    const keys = Object.keys(value).sort().join(','), v = value as Record<string, unknown>;
    if (keys !== 'completed,dismissed,version' || v.version !== 1 || typeof v.completed !== 'boolean' || typeof v.dismissed !== 'boolean') return empty;
    return { version: 1, completed: v.completed, dismissed: v.dismissed };
  } catch { return empty; }
}
export function checklistVisible(rows: readonly ChecklistRow[], memory: ChecklistMemory, later: boolean): boolean {
  return !memory.dismissed && !memory.completed && !later && rows.some(row => row.state !== 'done');
}

/** Renderer-side copy of a native plugin reply; anything unexpected becomes the fixed unavailable state. */
export function readPluginStatus(value: unknown): PluginStatus {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.version !== 1 || !STATES.includes(v.state as PluginInstallState) ||
      !(v.pluginVersion === null || typeof v.pluginVersion === 'string' && VERSION.test(v.pluginVersion)) ||
      typeof v.message !== 'string' || v.message.length > 512 || /[\x00-\x1f\x7f]/.test(v.message)) return { state: 'unavailable', pluginVersion: null, message: PLUGIN_MESSAGES.failed };
  return { state: v.state as PluginInstallState, pluginVersion: v.pluginVersion as string | null, message: v.message };
}

// ---- Studio plugin update banner ----
// Compares two things with the plugin bundled in this Arcane: the plugin file in Studio's Plugins folder (native status) and
// the plugin a live Studio session paired with (the daemon's display-only report). One click updates through the native
// host (backup, verified copy, native confirm); Arcane then asks for a Studio restart and notices when the new plugin pairs.
export type PluginBannerKind = 'hidden' | 'available' | 'restart' | 'stale' | 'ready';
export interface PluginBannerInput {
  desktop: boolean; plugin: PluginStatus | null;
  /** Null without a live Studio session; false when the paired plugin predates the bundled one. */
  pairedCurrent: boolean | null;
  /** This app run replaced the plugin file. */
  justUpdated: boolean;
}
export const PLUGIN_BANNER_TEXT = Object.freeze({
  available: 'Studio plugin update available — this version of Arcane needs a newer Arcane plugin in Roblox Studio.',
  restart: 'Studio plugin is ready. Restart Roblox Studio (or turn the Arcane plugin off and on under Plugins › Manage Plugins) to load it. Arcane will notice when it reconnects.',
  stale: 'Roblox Studio is still running an older Arcane plugin. Restart Roblox Studio to load the installed update.',
  staleBrowser: 'The connected Arcane Studio plugin is older than this app. Update it from the Arcane desktop app, then restart Roblox Studio.',
  ready: 'Studio is running the updated Arcane plugin.',
});
/** Pure: which plugin banner (if any) the observed state calls for. */
export function pluginBannerKind(s: PluginBannerInput): PluginBannerKind {
  if (s.desktop && s.plugin?.state === 'outdated') return 'available';
  if (s.pairedCurrent === false) return s.justUpdated ? 'restart' : 'stale';
  if (s.justUpdated) return s.pairedCurrent === true ? 'ready' : 'restart';
  return 'hidden';
}
export interface PluginPreference { autoUpdate: boolean; message: string }
export function readPluginPreference(value: unknown): PluginPreference | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.version !== 1 || typeof v.autoUpdate !== 'boolean' || typeof v.message !== 'string' || v.message.length > 512 || /[\x00-\x1f\x7f]/.test(v.message)) return null;
  return { autoUpdate: v.autoUpdate, message: v.message };
}

interface PluginBridge {
  version: 1; status(): Promise<unknown>; install(): Promise<unknown>;
  autoUpdate?(): Promise<unknown>; preference?(): Promise<unknown>; enableAutoUpdate?(): Promise<unknown>; disableAutoUpdate?(): Promise<unknown>;
}
interface ProjectBridge { version: 1; open(): Promise<unknown> }
function bridges(desktop: unknown): { plugin: PluginBridge | null; project: ProjectBridge | null } {
  const root = desktop && typeof desktop === 'object' ? desktop as Record<string, unknown> : null;
  const plugin = root?.studioPlugin as Record<string, unknown> | undefined, project = root?.workspaceProject as Record<string, unknown> | undefined;
  return {
    plugin: plugin && plugin.version === 1 && typeof plugin.status === 'function' && typeof plugin.install === 'function' ? plugin as unknown as PluginBridge : null,
    project: project && project.version === 1 && typeof project.open === 'function' ? project as unknown as ProjectBridge : null,
  };
}

export interface SetupChecklistOptions {
  /** App-owned presentation memory; survives the temporary browser session and daemon port. */
  persistence?: SetupChecklistPersistence | null;
  provider: {
    isSignedIn(): boolean; chatSurface(): 'codex' | 'claude' | 'arcane'; selectedProvider(): 'codex' | 'claude';
    subscribeSignInChange(listener: () => void): () => void; subscribeChatSurface(listener: () => void): () => void;
    /** Reopens the sign-in page after Continue without signing in; true when it is showing. */
    showSignIn?(): boolean;
  };
  workbench: {
    studioConnected(): boolean | null; subscribeStudioChange(listener: () => void): () => void;
    getCurrentProduct(): Readonly<{ projectPath: string }> | null; subscribeProjectChange(listener: () => void): () => void;
    /** Null without a live session; false when the paired plugin predates the bundled one. Notified through subscribeStudioChange. */
    studioPluginCurrent?(): boolean | null;
  };
  /** Banner timers (tests); defaults to window timers. */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** The preload bridge (window.arcaneDesktop); absent in a plain browser. */
  desktop?: unknown;
  /** One-click Studio pairing; without it the Studio row keeps the API key flow. */
  pairing?: { available(): boolean; view(): ChecklistPairing; start(): Promise<void>; subscribe(listener: () => void): () => void } | null;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}
export interface SetupChecklistController {
  rows(): ChecklistRow[]; visible(): boolean; memory(): ChecklistMemory;
  /** The plugin update banner currently shown ('hidden' when none). */
  pluginBanner(): PluginBannerKind;
  refreshPlugin(): Promise<void>; stop(): void; resume(): void; cleanup(): void;
}
export interface SetupChecklistPersistence {
  read(): Promise<{available: boolean; memory: ChecklistMemory | null}>;
  save(memory: ChecklistMemory): Promise<{saved: true}>;
}

const TICK = 'M5 12.5 10 17 19 7';
/** The Studio row right after this app installed the plugin: Studio has to restart before the plugin can take the code. */
export function pairAfterInstallText(code: string): string {
  return 'Restart Roblox Studio so it loads the plugin. Then open Arcane in Studio’s Plugins tab, type ' + code.slice(0, 3) + ' ' + code.slice(3) + ' and click Connect.';
}
export function startSetupChecklist(doc: Document, options: SetupChecklistOptions): SetupChecklistController {
  const root = doc.getElementById('setup-checklist'), list = doc.getElementById('setup-checklist-items');
  const native = bridges(options.desktop), storage = options.storage ?? null;
  const desktopMemory = (options.desktop as {setupChecklist?: SetupChecklistPersistence & {version: number}} | null)?.setupChecklist;
  const persistence = options.persistence ?? (desktopMemory?.version === 1 && typeof desktopMemory.read === 'function' && typeof desktopMemory.save === 'function' ? desktopMemory : null);
  const removers: (() => void)[] = [];
  let plugin: PluginStatus | null = null, pluginBusy = false, later = false, stopped = false, disposed = false, notice = '';
  // Plugin update banner and the "update automatically" choice (null until the host answered).
  let autoUpdate: boolean | null = null, autoTried = false, justUpdated = false, lastPaired: boolean | null = null;
  let bannerKind: PluginBannerKind = 'hidden', bannerDismissed: PluginBannerKind | null = null, readyTimer: unknown = null;
  const timers = options.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (handle: unknown) => clearTimeout(handle as number) };
  const pairedCurrent = (): boolean | null => { try { return options.workbench.studioPluginCurrent?.() ?? null; } catch { return null; } };
  let memory = (() => { try { return readChecklistMemory(storage?.getItem(SETUP_CHECKLIST_KEY)); } catch { return readChecklistMemory(null); } })();
  let hydrated = !persistence, automatic = !persistence, forced = false, revision = 0, preferenceError = '';
  let pendingSave: Promise<void> = Promise.resolve();
  const save = (next: ChecklistMemory) => {
    memory = {...next}; revision++;
    try { storage?.setItem(SETUP_CHECKLIST_KEY, JSON.stringify(next)); } catch { /* Only the reminder is lost. */ }
    if (persistence) {
      const snapshot = {...next};
      pendingSave = pendingSave.then(() => persistence.save(snapshot)).then(reply => {
        if (reply.saved !== true) throw new Error('Preference save refused');
        preferenceError = ''; render();
      }).catch(() => { preferenceError = 'Your setup checklist preference could not be saved. Try Hide checklist again.'; render(); });
    }
  };
  const signals = (): ChecklistSignals => {
    let signedIn = false, providerName: 'ChatGPT' | 'Claude' | 'Arcane' = 'ChatGPT', studio: boolean | null = null, path: string | null = null;
    try { signedIn = options.provider.isSignedIn() || options.provider.chatSurface() !== 'codex'; } catch { signedIn = false; }
    try { const surface = options.provider.chatSurface(); providerName = surface === 'arcane' ? 'Arcane' : surface === 'claude' || options.provider.selectedProvider() === 'claude' ? 'Claude' : 'ChatGPT'; } catch { /* Default label. */ }
    try { studio = options.workbench.studioConnected(); } catch { studio = null; }
    try { path = options.workbench.getCurrentProduct()?.projectPath ?? null; } catch { path = null; }
    let pairing: ChecklistPairing | null = null;
    try { if (options.pairing?.available()) { const view = options.pairing.view(); pairing = { phase: view.phase, code: view.code, message: view.message }; } } catch { pairing = null; }
    return { signedIn, providerName, plugin, desktop: !!native.plugin, studioConnected: studio, projectPath: path, pairing };
  };
  const rows = () => checklistRows(signals());
  const el = (id: string) => doc.getElementById(id);
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
  };
  const tick = (done: boolean) => {
    const ns = 'http://www.w3.org/2000/svg', svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'setup-check');
    if (done) { const path = doc.createElementNS(ns, 'path'); path.setAttribute('d', TICK); svg.append(path); }
    return svg;
  };
  let banner: { root: HTMLElement; message: HTMLElement; update: HTMLButtonElement; auto: HTMLButtonElement; dismiss: HTMLButtonElement } | null = null;
  const mountBanner = () => {
    if (banner) return banner;
    const messages = el('codex-messages'), parent = messages?.parentElement;
    if (!messages || !parent) return null;
    const root = make('div', undefined, 'notice warning studio-connection-banner studio-plugin-banner');
    root.id = 'studio-plugin-banner'; root.setAttribute('role', 'status'); root.setAttribute('aria-live', 'polite'); root.hidden = true;
    const button = (text: string, className: string, action: string) => { const node = make('button', text, className); node.type = 'button'; node.dataset.pluginBanner = action; return node; };
    banner = { root, message: make('p', '', 'studio-plugin-banner-message'), update: button('Update plugin', 'secondary studio-connection-reconnect', 'update'),
      auto: button('Update automatically', 'quiet studio-plugin-banner-auto', 'auto'), dismiss: button('Not now', 'quiet studio-plugin-banner-dismiss', 'dismiss') };
    root.append(banner.message, banner.update, banner.auto, banner.dismiss);
    parent.insertBefore(root, messages);
    const click = (event: Event) => {
      const target = (event.target as Element | null)?.closest?.('button[data-plugin-banner]') as HTMLButtonElement | null;
      if (!target || target.disabled || stopped || disposed || !event.isTrusted) return;
      const action = target.dataset.pluginBanner;
      if (action === 'update') act('install-plugin', event);
      else if (action === 'auto') void setAutoUpdate(true);
      else if (action === 'dismiss') { bannerDismissed = bannerKind; render(); }
    };
    root.addEventListener('click', click); removers.push(() => root.removeEventListener('click', click));
    return banner;
  };
  const paintBanner = () => {
    const kind = pluginBannerKind({ desktop: !!native.plugin, plugin, pairedCurrent: pairedCurrent(), justUpdated });
    if (kind !== bannerKind) {
      bannerKind = kind; bannerDismissed = null;
      if (readyTimer !== null) { timers.clear(readyTimer); readyTimer = null; }
      // The confirmation that Studio runs the new plugin clears itself.
      if (kind === 'ready') readyTimer = timers.set(() => { readyTimer = null; justUpdated = false; render(); }, 6000);
    }
    const b = mountBanner(); if (!b) return;
    const show = !stopped && kind !== 'hidden' && bannerDismissed !== kind;
    b.root.hidden = !show;
    b.root.className = 'notice ' + (kind === 'ready' ? 'good' : 'warning') + ' studio-connection-banner studio-plugin-banner';
    b.root.dataset.kind = kind;
    const text = kind === 'hidden' ? '' : kind === 'stale' && !native.plugin ? PLUGIN_BANNER_TEXT.staleBrowser : PLUGIN_BANNER_TEXT[kind];
    b.message.textContent = kind === 'available' && notice ? text + ' ' + notice : text;
    b.update.hidden = kind !== 'available'; b.update.disabled = pluginBusy || stopped; b.update.textContent = pluginBusy ? 'Updating…' : 'Update plugin';
    b.auto.hidden = kind !== 'available' || autoUpdate !== false || typeof native.plugin?.enableAutoUpdate !== 'function'; b.auto.disabled = pluginBusy || stopped;
    b.dismiss.hidden = kind === 'ready';
  };
  const renderSettings = () => {
    const auto = el('studio-plugin-auto') as HTMLInputElement | null;
    if (auto) { auto.checked = autoUpdate === true; auto.disabled = typeof native.plugin?.preference !== 'function' || autoUpdate === null || pluginBusy || stopped; }
    const state = el('studio-plugin-state'), status = el('studio-plugin-status');
    const install = el('studio-plugin-install') as HTMLButtonElement | null, refresh = el('studio-plugin-refresh') as HTMLButtonElement | null;
    const label = !native.plugin ? 'Desktop app only' : !plugin ? 'Checking' : plugin.state === 'installed' ? 'Installed' : plugin.state === 'outdated' ? 'Update available' : plugin.state === 'missing' ? 'Not installed' : 'Unavailable';
    if (state) { state.textContent = label; state.className = 'status-text ' + (plugin?.state === 'installed' ? 'good' : plugin?.state === 'outdated' || plugin?.state === 'missing' ? 'warning' : 'neutral'); }
    if (status) status.textContent = preferenceError || notice || (!native.plugin ? PLUGIN_MESSAGES.desktop : plugin ? plugin.message + (plugin.pluginVersion ? ' Bundled version ' + plugin.pluginVersion + '.' : '') : PLUGIN_MESSAGES.checking);
    if (install) { install.disabled = !native.plugin || pluginBusy || stopped || !plugin || plugin.state === 'installed' || plugin.state === 'unavailable'; install.textContent = pluginBusy ? 'Installing…' : plugin?.state === 'outdated' ? 'Update plugin' : 'Install plugin'; }
    if (refresh) refresh.disabled = !native.plugin || pluginBusy || stopped;
    const show = el('setup-checklist-show') as HTMLButtonElement | null;
    if (show) show.hidden = forced || !(memory.dismissed || memory.completed || later || !automatic);
  };
  const render = () => {
    if (disposed) return;
    const current = rows();
    if (hydrated && automatic && !memory.completed && current.every(row => row.state === 'done')) {
      save({ ...memory, completed: true });
      // Finished during this visit: say what comes next where the checklist was, from the top of the empty chat.
      if (root && !root.hidden && !stopped) {
        const ready = el('setup-ready'); if (ready) ready.hidden = false;
        try { const scroller = root.closest('.conversation-scroll'); if (scroller) scroller.scrollTop = 0; } catch { /* Optional. */ }
      }
    }
    renderSettings(); paintBanner();
    if (!root || !list) return;
    const visible = !stopped && (forced || hydrated && automatic && checklistVisible(current, memory, later));
    root.hidden = !visible;
    if (!visible) return;
    const done = current.filter(row => row.state === 'done').length;
    // The waiting 6-digit code, large enough to read across to Studio (display only; the row text says what to do).
    let code: string | null = null;
    try { const view = options.pairing?.available() ? options.pairing.view() : null; code = view?.phase === 'waiting' && view.code && /^[0-9]{6}$/.test(view.code) ? view.code : null; } catch { code = null; }
    const progress = el('setup-checklist-progress'); if (progress) progress.textContent = done + ' of ' + current.length + ' ready';
    const items = current.map(row => {
      const item = make('li', undefined, 'setup-checklist-item');
      item.dataset.step = row.step; item.dataset.state = row.state;
      const text = make('div', undefined, 'setup-checklist-text');
      text.append(make('span', row.state === 'done' ? 'Done: ' : row.state === 'checking' ? 'Checking: ' : 'To do: ', 'visually-hidden'), make('strong', row.label),
        make('span', row.step === 'studio' && row.state !== 'done' && code && justUpdated ? pairAfterInstallText(code) : row.detail, 'setup-checklist-detail'));
      if (row.step === 'studio' && row.state !== 'done' && code) { const chip = make('code', code.slice(0, 3) + ' ' + code.slice(3), 'setup-checklist-code'); chip.setAttribute('aria-hidden', 'true'); text.append(chip); }
      item.append(tick(row.state === 'done'), text);
      if (row.action) {
        const button = make('button', row.action.kind === 'install-plugin' && pluginBusy ? 'Installing…' : row.action.label, 'secondary');
        button.type = 'button'; button.dataset.setupAction = row.action.kind;
        button.disabled = stopped || (pluginBusy && (row.action.kind === 'install-plugin' || row.action.kind === 'check-plugin'));
        item.append(button);
      }
      return item;
    });
    list.replaceChildren(...items);
    const status = el('setup-checklist-notice'); if (status) status.textContent = notice;
  };
  const refreshPlugin = async () => {
    if (!native.plugin || pluginBusy || disposed) { render(); return; }
    pluginBusy = true; render();
    try { plugin = readPluginStatus(await native.plugin.status()); }
    catch { plugin = { state: 'unavailable', pluginVersion: null, message: PLUGIN_MESSAGES.failed }; }
    finally { pluginBusy = false; render(); }
    if (plugin?.state === 'installed') autoTried = false;
    else if (plugin?.state === 'outdated') void runAutoUpdate();
  };
  const replyMessage = (value: unknown) => { const text = (value as Record<string, unknown> | null)?.message; return typeof text === 'string' && text.length <= 512 && !/[\x00-\x1f\x7f]/.test(text) ? text : ''; };
  const errorMessage = (error: unknown) => error instanceof Error && error.message.length <= 512 ? error.message : PLUGIN_MESSAGES.failed;
  const readPreference = async () => {
    if (typeof native.plugin?.preference !== 'function' || disposed) return;
    try { autoUpdate = readPluginPreference(await native.plugin.preference())?.autoUpdate ?? false; } catch { autoUpdate = false; }
    render();
    if (plugin?.state === 'outdated') void runAutoUpdate();
  };
  /** Opt-in only: the host re-checks the saved choice and replaces only an older Arcane plugin, once per detection. */
  const runAutoUpdate = async () => {
    const bridge = native.plugin;
    if (!bridge || typeof bridge.autoUpdate !== 'function' || autoUpdate !== true || autoTried || pluginBusy || stopped || disposed || plugin?.state !== 'outdated') return;
    autoTried = true; pluginBusy = true; render();
    try {
      const result = await bridge.autoUpdate() as Record<string, unknown>;
      if (result?.changed === true) justUpdated = true;
      notice = result?.changed === true ? replyMessage(result) : '';
    } catch (error) { notice = errorMessage(error); }
    finally { pluginBusy = false; }
    await refreshPlugin();
  };
  const setAutoUpdate = async (on: boolean) => {
    const bridge = native.plugin;
    const call = on ? bridge?.enableAutoUpdate : bridge?.disableAutoUpdate;
    if (!bridge || typeof call !== 'function' || pluginBusy || stopped || disposed) { render(); return; }
    pluginBusy = true; notice = ''; render();
    try { const value = readPluginPreference(await call.call(bridge)); if (value) { autoUpdate = value.autoUpdate; notice = value.message; } }
    catch (error) { notice = errorMessage(error); }
    finally { pluginBusy = false; render(); }
    if (autoUpdate === true) { autoTried = false; void runAutoUpdate(); }
  };
  const installPlugin = async () => {
    if (!native.plugin || pluginBusy || stopped || disposed) return;
    pluginBusy = true; notice = ''; render();
    try {
      const result = await native.plugin.install() as Record<string, unknown>;
      notice = replyMessage(result);
      if (result?.changed === true) justUpdated = true;
    } catch (error) { notice = errorMessage(error); }
    finally { pluginBusy = false; }
    // Re-read the file state from the host rather than trusting the install reply.
    await refreshPlugin();
    // The same click that installed the plugin also opens a 10 minute Studio code, so the user only clicks
    // Connect in the plugin after Studio restarts. Never when Studio is already connected.
    let connected: boolean | null = null; try { connected = options.workbench.studioConnected(); } catch { connected = null; }
    if (!stopped && !disposed && plugin?.state === 'installed' && connected !== true) { try { if (options.pairing?.available()) await options.pairing.start(); } catch { /* Connect Studio stays available. */ } }
  };
  const dispatch = (type: string, detail: Record<string, string>) => {
    const Event = doc.defaultView?.CustomEvent; if (Event) doc.dispatchEvent(new Event(type, { detail }));
  };
  const act = (kind: string, event: Event) => {
    if (stopped || disposed || !event.isTrusted) return;
    if (kind === 'sign-in') {
      // The sign-in card is right above: point at it rather than opening Settings behind it.
      const gate = el('provider-login-gate'), start = el('provider-login-start') as HTMLButtonElement | null;
      if (gate && !gate.hidden && start && !start.hidden) { try { gate.scrollIntoView({ block: 'nearest' }); } catch { /* Optional. */ } start.focus(); return; }
      // After Continue without signing in, the step reopens the full sign-in page.
      let reopened = false; try { reopened = options.provider.showSignIn?.() === true; } catch { reopened = false; }
      if (reopened) { const next = el('provider-login-start') as HTMLButtonElement | null; if (next && !next.hidden && !next.disabled) next.focus(); else el('provider-login-codex')?.focus(); return; }
      let provider: 'codex' | 'claude' = 'codex'; try { provider = options.provider.selectedProvider(); } catch { /* Default provider. */ }
      dispatch('workspace:providersetup', { provider });
    } else if (kind === 'install-plugin') void installPlugin();
    else if (kind === 'check-plugin') void refreshPlugin();
    else if (kind === 'show-key') dispatch('workspace:settingsrequest', { target: 'settings-key-heading' });
    else if (kind === 'review-studio') dispatch('workspace:settingsrequest', { target: 'studio-plugin-heading' });
    else if (kind === 'connect-studio' && options.pairing) void options.pairing.start().catch(() => { /* The row shows the pairing error. */ });
    else if (kind === 'open-project' && native.project) {
      notice = ''; void native.project.open().catch(() => { notice = 'The project picker is unavailable. Use File > Open project.'; render(); });
    }
  };
  const listen = (target: EventTarget | null, type: string, handler: (event: Event) => void) => {
    if (!target) return; target.addEventListener(type, handler); removers.push(() => target.removeEventListener(type, handler));
  };
  listen(list, 'click', event => {
    const button = (event.target as Element | null)?.closest?.('button[data-setup-action]') as HTMLButtonElement | null;
    if (button && !button.disabled) act(button.dataset.setupAction ?? '', event);
  });
  listen(el('setup-checklist-later'), 'click', event => { if (event.isTrusted) { forced = false; later = true; save({ ...memory, dismissed: true }); render(); } });
  listen(el('setup-checklist-hide'), 'click', event => { if (event.isTrusted) { forced = false; save({ ...memory, dismissed: true }); render(); } });
  listen(el('setup-checklist-show'), 'click', event => { if (event.isTrusted) { forced = memory.completed || !automatic; later = false; save({ ...memory, dismissed: false }); render(); } });
  listen(el('studio-plugin-install'), 'click', event => act('install-plugin', event));
  listen(el('studio-plugin-refresh'), 'click', event => act('check-plugin', event));
  listen(el('studio-plugin-auto'), 'change', event => {
    const input = event.target as HTMLInputElement | null;
    if (!input || !event.isTrusted || stopped || disposed) { render(); return; }
    const want = input.checked; input.checked = autoUpdate === true; // The host's answer decides, after its own confirm.
    void setAutoUpdate(want);
  });
  // Pairing: a newly paired plugin that predates the bundled one re-reads the plugin file once (the banner then offers the
  // update or a Studio restart); a current one after an update clears the banner.
  try {
    removers.push(options.workbench.subscribeStudioChange(() => {
      const paired = pairedCurrent();
      if (paired === false && lastPaired !== false && !stopped) void refreshPlugin();
      lastPaired = paired;
    }));
  } catch { /* The banner keeps the plugin file signal only. */ }
  // Returning from Studio re-reads the local plugin file once; there is no polling.
  listen(doc.defaultView, 'focus', () => { if (!stopped && native.plugin && plugin?.state !== 'installed') void refreshPlugin(); });
  for (const subscribe of [options.provider.subscribeSignInChange, options.provider.subscribeChatSurface, options.workbench.subscribeStudioChange, options.workbench.subscribeProjectChange]) {
    try { removers.push(subscribe(render)); } catch { /* A missing signal only leaves its row pending. */ }
  }
  if (options.pairing) { try { removers.push(options.pairing.subscribe(render)); } catch { /* The row keeps its last state. */ } }
  if (persistence) {
    void persistence.read().then(value => {
      if (disposed) return;
      automatic = value.available;
      if (revision === 0 && value.memory) memory = {...value.memory};
      else if (revision === 0 && value.available && (memory.completed || memory.dismissed)) save(memory);
    }).catch(() => { automatic = false; }).finally(() => { hydrated = true; render(); });
  }
  render(); void refreshPlugin(); void readPreference();
  return {
    rows, visible: () => !!root && !root.hidden, memory: () => ({ ...memory }), refreshPlugin,
    pluginBanner: () => banner && !banner.root.hidden ? bannerKind : 'hidden',
    stop() { stopped = true; render(); },
    resume() { if (disposed || !stopped) return; stopped = false; render(); void refreshPlugin(); },
    cleanup() {
      if (disposed) return; stopped = true; disposed = true;
      if (readyTimer !== null) { timers.clear(readyTimer); readyTimer = null; }
      for (const remove of removers.splice(0)) { try { remove(); } catch { /* Already removed. */ } }
      if (root) root.hidden = true; if (banner) banner.root.hidden = true;
    },
  };
}

// ---- Studio connection banner ----
// Shown only after a live Studio session drops (the workbench's own liveness: a plugin heartbeat within 30 s). The plugin
// reconnects by itself; after a grace period the banner offers "Reconnect Studio" (an immediate re-read). Arcane tools refuse
// commands to an offline session (SESSION_OFFLINE), so nothing is sent while this shows. Display only: no command or write.
export const STUDIO_BANNER_TEXT = Object.freeze({
  reconnecting: 'Studio disconnected \u2014 reconnecting\u2026',
  offline: 'Studio is still disconnected. Arcane will not send it commands until it is back. Open your place in Roblox Studio with the Arcane plugin on, or reconnect now.',
  checking: 'Checking for Studio\u2026',
  reconnected: 'Studio reconnected.',
});
export type StudioBannerState = 'hidden' | 'reconnecting' | 'offline' | 'reconnected';
/** The sidebar footer's Studio line. Green and yellow come only from the live session; with no session yet it stays neutral. */
export const SIDEBAR_STUDIO_TEXT = Object.freeze({ paired: 'Studio paired', reconnecting: 'Reconnecting\u2026', reconnect: 'Reconnect Studio', none: 'Studio offline', unknown: 'Checking Studio\u2026' });
export type SidebarStudioState = 'paired' | 'reconnect' | 'none' | 'unknown';
export interface StudioBannerOptions {
  workbench: { studioConnected(): boolean | null; subscribeStudioChange(listener: () => void): () => void; refresh(): Promise<void>; studioPlaceName?(): string | null };
  /** How long the plugin's own recovery runs before the banner asks for a manual reconnect. */
  graceMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}
export function startStudioConnectionBanner(doc: Document, options: StudioBannerOptions): { state(): StudioBannerState; stop(): void; resume(): void; cleanup(): void } {
  const grace = options.graceMs ?? 60000, timers = options.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (handle: unknown) => clearTimeout(handle as number) };
  let state: StudioBannerState = 'hidden', wasLive = false, stopped = false, checking = false, timer: unknown = null;
  let root: HTMLElement | null = null, message: HTMLElement | null = null, button: HTMLButtonElement | null = null;
  const connected = (): boolean | null => { try { return options.workbench.studioConnected(); } catch { return null; } };
  const clear = () => { if (timer !== null) { timers.clear(timer); timer = null; } };
  function mount(): boolean {
    if (root) return true;
    const messages = doc.getElementById('codex-messages'), parent = messages?.parentElement;
    if (!messages || !parent) return false;
    root = doc.createElement('div'); root.id = 'studio-connection-banner'; root.className = 'notice warning studio-connection-banner';
    root.setAttribute('role', 'status'); root.setAttribute('aria-live', 'polite'); root.hidden = true;
    message = doc.createElement('p'); message.className = 'studio-connection-message';
    button = doc.createElement('button'); button.type = 'button'; button.className = 'secondary studio-connection-reconnect'; button.textContent = 'Reconnect Studio';
    button.addEventListener('click', () => { void reconnect(); });
    root.append(message, button); parent.insertBefore(root, messages);
    return true;
  }
  function paintSidebar(): void {
    const card = doc.getElementById('sidebar-status-card'), label = doc.getElementById('sidebar-studio-status');
    if (stopped || !card || !label) return;
    const live = connected(), down = state === 'reconnecting' || state === 'offline';
    const kind: SidebarStudioState = live === true ? 'paired' : down ? 'reconnect' : live === false ? 'none' : 'unknown';
    const text = kind === 'reconnect' ? (state === 'reconnecting' ? SIDEBAR_STUDIO_TEXT.reconnecting : SIDEBAR_STUDIO_TEXT.reconnect) : SIDEBAR_STUDIO_TEXT[kind];
    card.setAttribute('data-studio', kind);
    card.classList.toggle('studio-status--paired', kind === 'paired'); card.classList.toggle('studio-status--reconnect', kind === 'reconnect');
    if (label.textContent !== text) { label.textContent = text; label.title = text; }
    // The paired place's name (display only) for the compact header's Studio line; absent unless the live session names one.
    let place: string | null = null;
    if (kind === 'paired') { try { place = options.workbench.studioPlaceName?.() ?? null; } catch { place = null; } }
    if (place) { if (card.getAttribute('data-place') !== place) card.setAttribute('data-place', place); } else card.removeAttribute('data-place');
  }
  function paint(): void {
    paintSidebar();
    if (!mount() || !root || !message || !button) return;
    root.hidden = stopped || state === 'hidden';
    root.className = 'notice ' + (state === 'reconnected' ? 'good' : 'warning') + ' studio-connection-banner';
    message.textContent = checking ? STUDIO_BANNER_TEXT.checking : state === 'hidden' ? '' : STUDIO_BANNER_TEXT[state];
    button.hidden = state === 'hidden' || state === 'reconnected'; button.disabled = checking;
  }
  function observe(): void {
    if (stopped) return;
    const live = connected();
    if (live === true) {
      const wasDown = state === 'reconnecting' || state === 'offline';
      wasLive = true; clear();
      if (wasDown) { state = 'reconnected'; timer = timers.set(() => { timer = null; if (state === 'reconnected') { state = 'hidden'; paint(); } }, 4000); }
    } else if (live === false && wasLive && (state === 'hidden' || state === 'reconnected')) {
      clear(); state = 'reconnecting';
      timer = timers.set(() => { timer = null; if (state === 'reconnecting') { state = 'offline'; paint(); } }, grace);
    }
    paint();
  }
  async function reconnect(): Promise<void> {
    if (checking || stopped) return;
    checking = true; paint();
    try { await options.workbench.refresh(); } catch { /* The banner keeps its state; the next refresh retries. */ }
    checking = false; observe();
  }
  let remove: (() => void) | null = null;
  try { remove = options.workbench.subscribeStudioChange(observe); } catch { remove = null; }
  observe();
  return {
    state: () => state,
    stop() { stopped = true; clear(); paint(); },
    resume() { if (!stopped) return; stopped = false; observe(); },
    cleanup() { stopped = true; clear(); try { remove?.(); } catch { /* Already removed. */ } remove = null; if (root) root.hidden = true; },
  };
}
