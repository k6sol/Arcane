/// <reference lib="dom" />

/**
 * The composer's Playtest switch (#playtest-toggle). Off by default and remembered per project in this browser.
 * Off: the assistant is told not to request playtests and every request keeps the human review in the Playtests panel.
 * On: the assistant may run one bounded playtest after building, and the Playtests panel approves requests from the
 * managed chat automatically (see startPlaytestPanel's autoApprove option). The switch grants nothing by itself.
 */
export interface PlaytestToggleOptions {
  /** Stable project identity for the remembered choice; null while it is not known yet. */
  projectKey?: () => string | null;
  /** Browser storage; omitted reads window.localStorage when available. Null keeps the choice for this page only. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}
export interface PlaytestToggleController {
  enabled(): boolean;
  subscribe(listener: (enabled: boolean) => void): () => void;
  stop(): void;
}
export const PLAYTEST_TOGGLE_ID = 'playtest-toggle';
export const PLAYTEST_TOGGLE_HINT = 'Let Arcane playtest after building';
const STORAGE_PREFIX = 'arcane.playtest-toggle.v1:';
const SYNC_MS = 1000;

/** The switch state as the composer shows it: true only when the switch is mounted and on. */
export function playtestToggleOn(doc: Document): boolean {
  try { return doc.getElementById(PLAYTEST_TOGGLE_ID)?.getAttribute('aria-checked') === 'true'; } catch { return false; }
}

export function startPlaytestToggle(doc: Document, options: PlaytestToggleOptions = {}): PlaytestToggleController {
  const button = doc.getElementById(PLAYTEST_TOGGLE_ID) as HTMLButtonElement | null;
  let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
  if (options.storage !== undefined) storage = options.storage;
  else { try { storage = doc.defaultView?.localStorage ?? null; } catch { storage = null; } }
  const listeners = new Set<(enabled: boolean) => void>();
  let on = false, key: string | null = null, stopped = false, timer: ReturnType<typeof setInterval> | undefined;
  const projectKey = (): string => {
    try { const value = options.projectKey?.(); return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : 'default'; }
    catch { return 'default'; }
  };
  const read = (name: string): boolean => { try { return storage?.getItem(STORAGE_PREFIX + name) === 'on'; } catch { return false; } };
  const write = (name: string, value: boolean): void => { try { storage?.setItem(STORAGE_PREFIX + name, value ? 'on' : 'off'); } catch { /* Kept for this page only. */ } };
  function paint(): void {
    if (!button) return;
    button.setAttribute('role', 'switch'); button.setAttribute('aria-checked', String(on));
    button.dataset.state = on ? 'on' : 'off';
    button.title = PLAYTEST_TOGGLE_HINT + (on ? ' (on)' : ' (off)');
    const state = button.querySelector<HTMLElement>('.playtest-toggle-state');
    if (state) state.textContent = on ? 'On' : 'Off';
  }
  function set(value: boolean, persist: boolean): void {
    if (value === on) { paint(); return; }
    on = value; if (persist && key) write(key, on); paint();
    for (const listener of [...listeners]) { try { listener(on); } catch { /* A listener cannot break the switch. */ } }
  }
  /** Re-reads the remembered choice when the project identity becomes known or changes. */
  function sync(): void {
    if (stopped) return;
    const next = projectKey();
    if (next === key) return;
    key = next; set(read(next), false);
  }
  const click = (event: Event) => { if (stopped || !button || button.disabled) return; event.preventDefault(); sync(); set(!on, true); };
  button?.addEventListener('click', click);
  sync(); paint();
  timer = setInterval(sync, SYNC_MS);
  return {
    enabled() { sync(); return !stopped && on; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    stop() {
      if (stopped) return;
      stopped = true; if (timer !== undefined) clearInterval(timer); timer = undefined;
      button?.removeEventListener('click', click); listeners.clear();
    },
  };
}
