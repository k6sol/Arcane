/**
 * Build-done notifications (renderer side). When a chat turn finishes while the Arcane window is not focused, asks the
 * desktop host (apps/desktop/electron/build-notifications.cjs) for one native OS notification:
 *   'Arcane — Build finished'        a ChatGPT or Claude turn completed;
 *   'Arcane — Needs your attention'  a Claude turn failed, or ChatGPT is waiting for an approval.
 * Signals come only from existing events: the Claude bridge's `done` events (claudeChat.onEvent) and the shared composer's
 * submit button state (`#codex-submit[data-task-state]`) plus the Codex approval section, observed while the ChatGPT
 * surface owns the composer. Neither chat controller is edited. Clicking a notification focuses the window (host side)
 * and selects the chat tab that ran the turn when it is still open. Settings > Notify when a build finishes (default on)
 * is remembered in this browser profile only. The body is a short fixed phrase plus the tab title, at most 120 characters.
 */

export const NOTIFY_SETTING_KEY = 'arcane.build-notifications.v1';
export const NOTIFY_TOGGLE_ID = 'settings-notify-build';
export const NOTIFY_BODY_MAX = 120;
type Kind = 'finished' | 'attention';
type Provider = 'codex' | 'claude';
interface NotificationsBridge {
  notify(request: { kind: Kind; body: string; target: string }): Promise<unknown>;
  onActivate(listener: (event: { target: string }) => void): () => void;
}
interface ClaudeBridge { onEvent(listener: (event: unknown) => void): () => void }
export interface BuildNotificationOptions {
  desktop?: { notifications?: NotificationsBridge; claudeChat?: ClaudeBridge } | null;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

const STRIPS: Record<Provider, string> = { codex: 'workspace-chat-tabs', claude: 'claude-chat-tabs' };
const NAMES: Record<Provider, string> = { codex: 'ChatGPT', claude: 'Claude' };
const TARGETS_KEPT = 16;

/** Plain one-line text of at most `max` characters (control and bidi characters removed). */
export function boundedText(value: unknown, max = NOTIFY_BODY_MAX): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

/** Fixed phrase per provider and outcome, plus the chat title; the whole body stays within 120 characters. */
export function notificationBody(provider: Provider, kind: Kind, title: string, reason: 'done' | 'failed' | 'approval' = kind === 'finished' ? 'done' : 'failed'): string {
  const name = NAMES[provider];
  const phrase = reason === 'approval' ? name + ' is waiting for your approval' : reason === 'failed' ? name + ' stopped and needs a look' : name + ' finished';
  const chat = boundedText(title, 80);
  return boundedText(chat ? phrase + ' in “' + chat + '”.' : phrase + '.');
}

/** Reads the saved toggle; default on. */
export function notificationsEnabled(storage: BuildNotificationOptions['storage']): boolean {
  try {
    const raw = storage?.getItem(NOTIFY_SETTING_KEY);
    if (!raw) return true;
    const value = JSON.parse(raw) as unknown;
    return !(value && typeof value === 'object' && (value as { version?: unknown }).version === 1 && (value as { enabled?: unknown }).enabled === false);
  } catch { return true; }
}

export function startBuildNotifications(doc: Document, options: BuildNotificationOptions) {
  const bridge = options.desktop?.notifications;
  const available = !!bridge && typeof bridge.notify === 'function' && typeof bridge.onActivate === 'function';
  const storage = options.storage ?? null;
  let enabled = notificationsEnabled(storage), counter = 0, stopped = false;
  const targets = new Map<string, { provider: Provider; key: string | null }>();
  const removers: (() => void)[] = [];
  const el = (id: string) => doc.getElementById(id);

  const surface = (): Provider => el(STRIPS.claude)?.hidden === false ? 'claude' : 'codex';
  const tabOf = (provider: Provider, selector: string) => el(STRIPS[provider])?.querySelector<HTMLElement>('[role=tab]' + selector) ?? null;
  const focused = () => { try { return doc.visibilityState === 'visible' && doc.hasFocus(); } catch { return false; } };

  function send(provider: Provider, kind: Kind, key: string | null, reason?: 'done' | 'failed' | 'approval'): void {
    if (stopped || !available || !enabled || focused()) return;
    const tab = key ? Array.from(el(STRIPS[provider])?.querySelectorAll<HTMLElement>('[role=tab]') ?? []).find(node => node.dataset.chatKey === key) ?? null : null;
    const target = 'n' + (++counter).toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    targets.set(target, { provider, key });
    while (targets.size > TARGETS_KEPT) targets.delete(targets.keys().next().value as string);
    const body = notificationBody(provider, kind, tab?.textContent ?? '', reason);
    void Promise.resolve().then(() => bridge!.notify({ kind, body, target })).catch(() => {});
  }

  function activate(event: { target: string }): void {
    const entry = targets.get(event?.target);
    if (!entry || stopped) return;
    targets.delete(event.target);
    if (!entry.key || surface() !== entry.provider) return;
    const tab = Array.from(el(STRIPS[entry.provider])?.querySelectorAll<HTMLButtonElement>('[role=tab]') ?? []).find(node => node.dataset.chatKey === entry.key);
    if (tab && !tab.disabled && tab.getAttribute('aria-selected') !== 'true') tab.click();
    tab?.focus({ preventScroll: true });
  }

  // ---- Settings toggle ----
  const toggle = el(NOTIFY_TOGGLE_ID) as HTMLInputElement | null;
  const note = el('settings-notify-note');
  if (toggle) {
    toggle.checked = enabled; toggle.disabled = !available;
    if (note) note.textContent = available ? '' : 'Desktop notifications are available in the Arcane desktop app.';
    const onChange = () => {
      enabled = toggle.checked;
      try { storage?.setItem(NOTIFY_SETTING_KEY, JSON.stringify({ version: 1, enabled })); if (note) note.textContent = enabled ? 'Notifications on.' : 'Notifications off.'; }
      catch { if (note) note.textContent = 'This choice applies until Arcane restarts.'; }
    };
    toggle.addEventListener('change', onChange);
    removers.push(() => toggle.removeEventListener('change', onChange));
  }
  if (!available) return { stop: () => { stopped = true; for (const remove of removers.splice(0)) remove(); }, enabled: () => enabled };

  try { removers.push(bridge!.onActivate(activate)); } catch { /* Clicks only focus the window. */ }

  // ---- Claude: the bridge's done events; the running tab is the one marked aria-busy while the turn streams. ----
  const claudeTabs = new Map<string, string>();
  const onClaude = (value: unknown) => {
    const event = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    if (!event || typeof event.turnId !== 'string') return;
    if (event.type !== 'done') {
      const busy = tabOf('claude', '[aria-busy="true"]')?.dataset.chatKey;
      if (busy && !claudeTabs.has(event.turnId)) { claudeTabs.set(event.turnId, busy); while (claudeTabs.size > TARGETS_KEPT) claudeTabs.delete(claudeTabs.keys().next().value as string); }
      return;
    }
    const key = claudeTabs.get(event.turnId) ?? tabOf('claude', '[aria-busy="true"]')?.dataset.chatKey ?? null;
    claudeTabs.delete(event.turnId);
    send('claude', event.ok === true ? 'finished' : 'attention', key, event.ok === true ? 'done' : 'failed');
  };
  try { const off = options.desktop?.claudeChat?.onEvent(onClaude); if (off) removers.push(off); } catch { /* Claude chat absent. */ }

  // ---- ChatGPT: the shared composer's task state while the ChatGPT surface owns it, and the approval section. ----
  const View = doc.defaultView;
  if (View && typeof View.MutationObserver === 'function') {
    let running: string | null | undefined;  // undefined: no ChatGPT turn observed as running
    const submit = el('codex-submit');
    if (submit) {
      const observer = new View.MutationObserver(() => {
        const state = submit.dataset.taskState;
        if (state === 'active' && running === undefined && surface() === 'codex') running = tabOf('codex', '[aria-selected="true"]')?.dataset.chatKey ?? null;
        else if (state !== 'active' && running !== undefined) {
          const key = running; running = undefined;
          if (surface() === 'codex') send('codex', 'finished', key, 'done');
        }
      });
      observer.observe(submit, { attributes: true, attributeFilter: ['data-task-state'] });
      removers.push(() => observer.disconnect());
    }
    const approvals = el('codex-approval-section');
    if (approvals) {
      let open = approvals.hidden === false;
      const observer = new View.MutationObserver(() => {
        const now = approvals.hidden === false;
        if (now && !open && surface() === 'codex') send('codex', 'attention', tabOf('codex', '[aria-selected="true"]')?.dataset.chatKey ?? null, 'approval');
        open = now;
      });
      observer.observe(approvals, { attributes: true, attributeFilter: ['hidden'] });
      removers.push(() => observer.disconnect());
    }
  }
  return { stop: () => { stopped = true; for (const remove of removers.splice(0)) { try { remove(); } catch { /* already gone */ } } }, enabled: () => enabled };
}
