/// <reference lib="dom" />
// First-run setup checklist and the Settings Studio plugin card. Every check reads existing local state only:
// provider sign-in evidence, the native plugin file status, reported Studio sessions and the open project.
// Nothing here starts a model call, a Studio command or a write without an explicit click.

export type ChecklistStep = 'provider' | 'plugin' | 'studio' | 'project';
export type ChecklistState = 'done' | 'todo' | 'checking' | 'unavailable';
export type PluginInstallState = 'installed' | 'outdated' | 'missing' | 'unavailable';
export type ChecklistAction = 'sign-in' | 'install-plugin' | 'check-plugin' | 'show-key' | 'open-project';

export interface PluginStatus { state: PluginInstallState; pluginVersion: string | null; message: string }
export interface ChecklistSignals {
  /** Fresh provider sign-in evidence; never inferred from saved preferences. */
  signedIn: boolean;
  providerName: 'ChatGPT' | 'Claude';
  /** Null while the first native read is pending. */
  plugin: PluginStatus | null;
  /** Desktop app bridge present: plugin install and project picker are available. */
  desktop: boolean;
  /** Null before the first Studio session read. */
  studioConnected: boolean | null;
  /** Null until the daemon reports the open project. */
  projectPath: string | null;
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
      ? { step: 'provider', label: 'Signed in', detail: 'Using your ' + s.providerName + ' account.', state: 'done', action: null }
      : { step: 'provider', label: 'Sign in', detail: 'Use your ChatGPT or Claude account.', state: 'todo', action: { kind: 'sign-in', label: 'Sign in' } },
    plugin,
    s.studioConnected === true
      ? { step: 'studio', label: 'Studio connected', detail: 'A live Studio session is paired.', state: 'done', action: null }
      : { step: 'studio', label: 'Connect Studio', detail: s.studioConnected === null ? 'Checking for a Studio session…' : 'Paste your Arcane API key into the plugin in Studio.',
        state: s.studioConnected === null ? 'checking' : 'todo', action: { kind: 'show-key', label: 'Show pairing key' } },
    s.projectPath
      ? { step: 'project', label: 'Project open', detail: isStarterProject(s.projectPath) ? 'Starter project. Open your own folder anytime.' : folderName(s.projectPath), state: 'done', action: null }
      : { step: 'project', label: 'Open a project', detail: s.desktop ? 'Choose the folder for your game.' : 'Open a project from the Arcane desktop app.', state: 'todo',
        action: s.desktop ? { kind: 'open-project', label: 'Open project' } : null },
  ];
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

interface PluginBridge { version: 1; status(): Promise<unknown>; install(): Promise<unknown> }
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
  provider: {
    isSignedIn(): boolean; chatSurface(): 'codex' | 'claude'; selectedProvider(): 'codex' | 'claude';
    subscribeSignInChange(listener: () => void): () => void; subscribeChatSurface(listener: () => void): () => void;
  };
  workbench: {
    studioConnected(): boolean | null; subscribeStudioChange(listener: () => void): () => void;
    getCurrentProduct(): Readonly<{ projectPath: string }> | null; subscribeProjectChange(listener: () => void): () => void;
  };
  /** The preload bridge (window.arcaneDesktop); absent in a plain browser. */
  desktop?: unknown;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}
export interface SetupChecklistController {
  rows(): ChecklistRow[]; visible(): boolean; memory(): ChecklistMemory;
  refreshPlugin(): Promise<void>; stop(): void; resume(): void; cleanup(): void;
}

const TICK = 'M5 12.5 10 17 19 7';
export function startSetupChecklist(doc: Document, options: SetupChecklistOptions): SetupChecklistController {
  const root = doc.getElementById('setup-checklist'), list = doc.getElementById('setup-checklist-items');
  const native = bridges(options.desktop), storage = options.storage ?? null;
  const removers: (() => void)[] = [];
  let plugin: PluginStatus | null = null, pluginBusy = false, later = false, stopped = false, disposed = false, notice = '';
  let memory = (() => { try { return readChecklistMemory(storage?.getItem(SETUP_CHECKLIST_KEY)); } catch { return readChecklistMemory(null); } })();
  const save = (next: ChecklistMemory) => {
    memory = next;
    try { storage?.setItem(SETUP_CHECKLIST_KEY, JSON.stringify(next)); } catch { /* Only the reminder is lost. */ }
  };
  const signals = (): ChecklistSignals => {
    let signedIn = false, providerName: 'ChatGPT' | 'Claude' = 'ChatGPT', studio: boolean | null = null, path: string | null = null;
    try { signedIn = options.provider.isSignedIn() || options.provider.chatSurface() === 'claude'; } catch { signedIn = false; }
    try { providerName = options.provider.chatSurface() === 'claude' || options.provider.selectedProvider() === 'claude' ? 'Claude' : 'ChatGPT'; } catch { /* Default label. */ }
    try { studio = options.workbench.studioConnected(); } catch { studio = null; }
    try { path = options.workbench.getCurrentProduct()?.projectPath ?? null; } catch { path = null; }
    return { signedIn, providerName, plugin, desktop: !!native.plugin, studioConnected: studio, projectPath: path };
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
  const renderSettings = () => {
    const state = el('studio-plugin-state'), status = el('studio-plugin-status');
    const install = el('studio-plugin-install') as HTMLButtonElement | null, refresh = el('studio-plugin-refresh') as HTMLButtonElement | null;
    const label = !native.plugin ? 'Desktop app only' : !plugin ? 'Checking' : plugin.state === 'installed' ? 'Installed' : plugin.state === 'outdated' ? 'Update available' : plugin.state === 'missing' ? 'Not installed' : 'Unavailable';
    if (state) { state.textContent = label; state.className = 'status-text ' + (plugin?.state === 'installed' ? 'good' : plugin?.state === 'outdated' || plugin?.state === 'missing' ? 'warning' : 'neutral'); }
    if (status) status.textContent = notice || (!native.plugin ? PLUGIN_MESSAGES.desktop : plugin ? plugin.message + (plugin.pluginVersion ? ' Bundled version ' + plugin.pluginVersion + '.' : '') : PLUGIN_MESSAGES.checking);
    if (install) { install.disabled = !native.plugin || pluginBusy || stopped || !plugin || plugin.state === 'installed' || plugin.state === 'unavailable'; install.textContent = pluginBusy ? 'Installing…' : plugin?.state === 'outdated' ? 'Update plugin' : 'Install plugin'; }
    if (refresh) refresh.disabled = !native.plugin || pluginBusy || stopped;
    const show = el('setup-checklist-show') as HTMLButtonElement | null;
    if (show) show.hidden = !(memory.dismissed || later) || memory.completed;
  };
  const render = () => {
    if (disposed) return;
    const current = rows();
    if (!memory.completed && current.every(row => row.state === 'done')) save({ ...memory, completed: true });
    renderSettings();
    if (!root || !list) return;
    const visible = !stopped && checklistVisible(current, memory, later);
    root.hidden = !visible;
    if (!visible) return;
    const done = current.filter(row => row.state === 'done').length;
    const progress = el('setup-checklist-progress'); if (progress) progress.textContent = done + ' of ' + current.length + ' ready';
    const items = current.map(row => {
      const item = make('li', undefined, 'setup-checklist-item');
      item.dataset.step = row.step; item.dataset.state = row.state;
      const text = make('div', undefined, 'setup-checklist-text');
      text.append(make('span', row.state === 'done' ? 'Done: ' : row.state === 'checking' ? 'Checking: ' : 'To do: ', 'visually-hidden'), make('strong', row.label), make('span', row.detail, 'setup-checklist-detail'));
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
  };
  const installPlugin = async () => {
    if (!native.plugin || pluginBusy || stopped || disposed) return;
    pluginBusy = true; notice = ''; render();
    try {
      const result = await native.plugin.install() as Record<string, unknown>;
      notice = typeof result?.message === 'string' && result.message.length <= 512 ? result.message : '';
    } catch (error) { notice = error instanceof Error && error.message.length <= 512 ? error.message : PLUGIN_MESSAGES.failed; }
    finally { pluginBusy = false; }
    // Re-read the file state from the host rather than trusting the install reply.
    await refreshPlugin();
  };
  const dispatch = (type: string, detail: Record<string, string>) => {
    const Event = doc.defaultView?.CustomEvent; if (Event) doc.dispatchEvent(new Event(type, { detail }));
  };
  const act = (kind: string, event: Event) => {
    if (stopped || disposed || !event.isTrusted) return;
    if (kind === 'sign-in') {
      let provider: 'codex' | 'claude' = 'codex'; try { provider = options.provider.selectedProvider(); } catch { /* Default provider. */ }
      dispatch('workspace:providersetup', { provider });
    } else if (kind === 'install-plugin') void installPlugin();
    else if (kind === 'check-plugin') void refreshPlugin();
    else if (kind === 'show-key') dispatch('workspace:settingsrequest', { target: 'settings-key-heading' });
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
  listen(el('setup-checklist-later'), 'click', event => { if (event.isTrusted) { later = true; render(); } });
  listen(el('setup-checklist-hide'), 'click', event => { if (event.isTrusted) { save({ ...memory, dismissed: true }); render(); } });
  listen(el('setup-checklist-show'), 'click', event => { if (event.isTrusted) { later = false; save({ ...memory, dismissed: false }); render(); } });
  listen(el('studio-plugin-install'), 'click', event => act('install-plugin', event));
  listen(el('studio-plugin-refresh'), 'click', event => act('check-plugin', event));
  // Returning from Studio re-reads the local plugin file once; there is no polling.
  listen(doc.defaultView, 'focus', () => { if (!stopped && native.plugin && plugin?.state !== 'installed') void refreshPlugin(); });
  for (const subscribe of [options.provider.subscribeSignInChange, options.provider.subscribeChatSurface, options.workbench.subscribeStudioChange, options.workbench.subscribeProjectChange]) {
    try { removers.push(subscribe(render)); } catch { /* A missing signal only leaves its row pending. */ }
  }
  render(); void refreshPlugin();
  return {
    rows, visible: () => !!root && !root.hidden, memory: () => ({ ...memory }), refreshPlugin,
    stop() { stopped = true; render(); },
    resume() { if (disposed || !stopped) return; stopped = false; render(); void refreshPlugin(); },
    cleanup() { if (disposed) return; stopped = true; disposed = true; for (const remove of removers.splice(0)) { try { remove(); } catch { /* Already removed. */ } } if (root) root.hidden = true; },
  };
}
