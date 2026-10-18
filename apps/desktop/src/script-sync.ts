/**
 * Settings › Project memory › Script sync: the opt-in switch, a status line (last sync and counts), and the lists that need a
 * person's decision (conflicts with Keep Studio / Keep file, deletions that are never propagated automatically, skipped files).
 * Everything goes through the daemon's human-only /v1/script-sync routes; file names are shown as text only. The state is read
 * only while the Project memory page is shown (the daemon runs the sync itself), never at workspace start.
 */

export const SCRIPT_SYNC_SECTION_ID = 'settings-memory';
const POLL_MS = 5000;

export interface ScriptSyncItemView { file: string; reason: string }
export interface ScriptSyncDeletionView { file: string; side: 'file' | 'studio' }
export interface ScriptSyncView {
  enabled: boolean; state: 'off' | 'waiting' | 'syncing' | 'ready' | 'error'; message: string; folder: string; lastSyncAt: string | null; place: string | null; writable: boolean;
  counts: { tracked: number; exported: number; imported: number; created: number; conflicts: number; deletions: number; skipped: number };
  conflicts: ScriptSyncItemView[]; deletions: ScriptSyncDeletionView[]; skipped: ScriptSyncItemView[];
}
export interface ScriptSyncOptions {
  token: () => string;
  /** Test seam; defaults to the page's fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}
export interface ScriptSyncController { reload(): Promise<void>; stop(): void; resume(): void }

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const items = (value: unknown): ScriptSyncItemView[] | null => Array.isArray(value) && value.length <= 50
  && value.every(item => item && typeof item === 'object' && text((item as ScriptSyncItemView).file, 1024) && text((item as ScriptSyncItemView).reason, 400))
  ? value.map(item => ({ file: (item as ScriptSyncItemView).file, reason: (item as ScriptSyncItemView).reason })) : null;

/** Strict reader for the daemon reply; anything unexpected yields null. */
export function readScriptSyncView(value: unknown): ScriptSyncView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>, c = v.counts as Record<string, unknown> | null;
  if (typeof v.enabled !== 'boolean' || !['off', 'waiting', 'syncing', 'ready', 'error'].includes(v.state as string) || !text(v.message, 400) || !text(v.folder, 64)
    || !(v.lastSyncAt === null || (text(v.lastSyncAt, 40) && Number.isFinite(Date.parse(v.lastSyncAt)))) || !(v.place === null || text(v.place, 256)) || typeof v.writable !== 'boolean'
    || !c || typeof c !== 'object' || !['tracked', 'exported', 'imported', 'created', 'conflicts', 'deletions', 'skipped'].every(key => count(c[key]))) return null;
  const conflicts = items(v.conflicts), skipped = items(v.skipped);
  const deletions = Array.isArray(v.deletions) && v.deletions.length <= 50 && v.deletions.every(item => item && typeof item === 'object'
    && text((item as ScriptSyncDeletionView).file, 1024) && ((item as ScriptSyncDeletionView).side === 'file' || (item as ScriptSyncDeletionView).side === 'studio'))
    ? (v.deletions as ScriptSyncDeletionView[]).map(item => ({ file: item.file, side: item.side })) : null;
  if (!conflicts || !skipped || !deletions) return null;
  return { enabled: v.enabled, state: v.state as ScriptSyncView['state'], message: v.message as string, folder: v.folder as string, lastSyncAt: v.lastSyncAt as string | null,
    place: v.place as string | null, writable: v.writable, counts: { tracked: c.tracked as number, exported: c.exported as number, imported: c.imported as number,
      created: c.created as number, conflicts: c.conflicts as number, deletions: c.deletions as number, skipped: c.skipped as number }, conflicts, deletions, skipped };
}

/** True while the Project memory page is on screen (kept local: this module has no imports). */
function sectionShown(doc: Document): boolean {
  const section = doc.getElementById(SCRIPT_SYNC_SECTION_ID);
  if (!section || section.hidden) return false;
  const drawer = section.closest('dialog');
  return !drawer || (drawer as HTMLDialogElement).open;
}
/** Calls `onShown` each time the page becomes visible; nothing is read at workspace start. */
function watchSection(doc: Document, onShown: () => void): () => void {
  const section = doc.getElementById(SCRIPT_SYNC_SECTION_ID), Observer = doc.defaultView?.MutationObserver;
  if (!section || !Observer) return () => {};
  let shown = sectionShown(doc);
  const observer = new Observer(() => { const next = sectionShown(doc); if (next && !shown) onShown(); shown = next; });
  observer.observe(section, { attributes: true, attributeFilter: ['hidden'] });
  const drawer = section.closest('dialog'); if (drawer) observer.observe(drawer, { attributes: true, attributeFilter: ['open'] });
  return () => observer.disconnect();
}

const plural = (n: number, one: string, many = one + 's') => n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many);
/** "Last sync 2 min ago · 14 scripts · 3 to files · 1 to Studio" for the status line. */
export function scriptSyncSummary(view: ScriptSyncView, now: number): string {
  if (!view.enabled) return 'Off. Scripts stay in Studio only.';
  const parts: string[] = [];
  if (view.lastSyncAt) {
    const seconds = Math.max(0, Math.round((now - Date.parse(view.lastSyncAt)) / 1000));
    parts.push('Last sync ' + (seconds < 10 ? 'just now' : seconds < 60 ? seconds + ' s ago' : seconds < 3600 ? Math.round(seconds / 60) + ' min ago' : new Date(view.lastSyncAt).toLocaleString()));
  } else parts.push('Not synced yet');
  parts.push(plural(view.counts.tracked, 'script'));
  if (view.counts.exported) parts.push(view.counts.exported.toLocaleString('en-US') + ' to files');
  if (view.counts.imported + view.counts.created) parts.push((view.counts.imported + view.counts.created).toLocaleString('en-US') + ' to Studio');
  if (view.place) parts.push(view.place);
  return parts.join(' · ');
}
const DELETION_ACTIONS: Record<'file' | 'studio', [string, string, string][]> = {
  file: [['restore', 'Restore file', 'secondary'], ['ignore', 'Stop syncing', 'quiet']],
  studio: [['delete-file', 'Delete file', 'quiet danger'], ['recreate', 'Recreate in Studio', 'secondary']],
};

export function startScriptSync(doc: Document, options: ScriptSyncOptions): ScriptSyncController {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T | null;
  const toggle = el<HTMLInputElement>('script-sync-enabled'), run = el<HTMLButtonElement>('script-sync-run');
  const status = el('script-sync-status'), summary = el('script-sync-summary'), notice = el('script-sync-notice');
  const conflictList = el('script-sync-conflicts'), deletionList = el('script-sync-deletions'), skippedList = el('script-sync-skipped');
  let view: ScriptSyncView | null = null, busy = false, stopped = false, timer: ReturnType<typeof setInterval> | null = null;
  const cleanups: (() => void)[] = [];
  const headers = (json: boolean): Record<string, string> => ({ Authorization: 'Bearer ' + options.token(), ...(json ? { 'Content-Type': 'application/json' } : {}) });
  const say = (value: string, kind: 'info' | 'error' = 'info') => { if (notice) { notice.textContent = value; notice.dataset.kind = kind; } };

  async function request(method: 'GET' | 'PUT' | 'POST', path: string, body?: Record<string, unknown>): Promise<{ view: ScriptSyncView | null; message: string }> {
    try {
      const response = await doFetch(path, { method, headers: headers(body !== undefined), cache: 'no-store', credentials: 'same-origin',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const reply: unknown = await response.json().catch(() => null);
      if (response.ok) { const next = readScriptSyncView(reply); return { view: next, message: next ? '' : 'Script sync returned an unexpected reply.' }; }
      const message = reply && typeof reply === 'object' && typeof (reply as { message?: unknown }).message === 'string' ? (reply as { message: string }).message.slice(0, 300) : '';
      return { view: null, message: message || 'Script sync is unavailable right now.' };
    } catch { return { view: null, message: 'Script sync is unavailable right now.' }; }
  }
  function row(list: HTMLElement, file: string, reason: string, actions: [string, string, string][], onAction: (action: string) => void): void {
    const item = doc.createElement('li'); item.className = 'script-sync-item';
    const name = doc.createElement('code'); name.className = 'script-sync-file'; name.textContent = file;
    const why = doc.createElement('span'); why.className = 'hint script-sync-reason'; why.textContent = reason;
    item.append(name, why);
    if (actions.length) {
      const buttons = doc.createElement('div'); buttons.className = 'button-row script-sync-actions';
      for (const [action, label, kind] of actions) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = kind; button.textContent = label;
        button.disabled = busy || stopped; button.setAttribute('aria-label', label + ': ' + file);
        button.addEventListener('click', () => onAction(action));
        buttons.append(button);
      }
      item.append(buttons);
    }
    list.append(item);
  }
  function render(): void {
    if (toggle) { toggle.disabled = busy || stopped || !view; toggle.checked = !!view?.enabled; }
    if (run) run.disabled = busy || stopped || !view?.enabled;
    if (status) { status.textContent = view ? view.message : 'Reading script sync…'; status.dataset.state = view?.state ?? 'off'; }
    if (summary) summary.textContent = view ? scriptSyncSummary(view, now()) : '';
    if (conflictList) {
      conflictList.replaceChildren();
      for (const item of view?.conflicts ?? []) row(conflictList, item.file, item.reason, [['studio', 'Keep Studio', 'secondary'], ['file', 'Keep file', 'secondary']],
        keep => void act('/v1/script-sync/resolve', { file: item.file, keep }, keep === 'studio' ? 'Studio version kept.' : 'File applied to Studio.'));
      conflictList.hidden = !view?.conflicts.length;
      const heading = el('script-sync-conflicts-heading'); if (heading) heading.hidden = !view?.conflicts.length;
    }
    if (deletionList) {
      deletionList.replaceChildren();
      for (const item of view?.deletions ?? []) row(deletionList, item.file,
        item.side === 'file' ? 'File deleted; the script is still in Studio. Delete it in Studio yourself, restore the file, or stop syncing it.'
          : 'Script removed in Studio; the file is still here. Delete the file, or recreate the script (disabled) from it.',
        DELETION_ACTIONS[item.side], action => void act('/v1/script-sync/deletion', { file: item.file, action }, 'Done.'));
      deletionList.hidden = !view?.deletions.length;
      const heading = el('script-sync-deletions-heading'); if (heading) heading.hidden = !view?.deletions.length;
    }
    if (skippedList) {
      skippedList.replaceChildren();
      for (const item of view?.skipped ?? []) row(skippedList, item.file, item.reason, [], () => {});
      const details = el('script-sync-skipped-details'); if (details) details.hidden = !view?.skipped.length;
    }
  }
  async function act(path: string, body: Record<string, unknown>, done: string): Promise<void> {
    if (busy || stopped) return;
    busy = true; render(); say('Working…');
    const result = await request(path === '/v1/script-sync' ? 'PUT' : 'POST', path, body);
    busy = false;
    if (stopped) return;
    if (result.view) { view = result.view; say(done); } else say(result.message, 'error');
    render(); schedule();
  }
  async function reload(): Promise<void> {
    if (stopped || busy) return;
    const result = await request('GET', '/v1/script-sync');
    if (stopped || busy) return;
    if (result.view) view = result.view; else say(result.message, 'error');
    render(); schedule();
  }
  /** Poll only while sync is on, so the status line and lists stay current. */
  function schedule(): void {
    const want = !stopped && !!view?.enabled;
    if (want && !timer) timer = setInterval(() => { if (!doc.hidden) void reload(); }, POLL_MS);
    if (!want && timer) { clearInterval(timer); timer = null; }
  }
  function bind(): void {
    if (!toggle || cleanups.length) return;
    const on = (target: EventTarget, type: string, handler: () => void) => { target.addEventListener(type, handler); cleanups.push(() => target.removeEventListener(type, handler)); };
    on(toggle, 'change', () => void act('/v1/script-sync', { enabled: toggle.checked }, toggle.checked ? 'Script sync is on. Scripts are being copied to the src folder.' : 'Script sync is off. Files and Studio scripts were left as they are.'));
    if (run) on(run, 'click', () => void act('/v1/script-sync/run', {}, 'Synced.'));
    for (const nav of Array.from(doc.querySelectorAll<HTMLElement>('[data-settings-section-target="' + SCRIPT_SYNC_SECTION_ID + '"]'))) on(nav, 'click', () => void reload());
    cleanups.push(watchSection(doc, () => void reload()));
  }
  function stop(): void { stopped = true; for (const cleanup of cleanups.splice(0)) cleanup(); schedule(); render(); }
  function resume(): void { stopped = false; bind(); render(); if (sectionShown(doc)) void reload(); }
  resume();
  return { reload, stop, resume };
}
