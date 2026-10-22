/// <reference lib="dom" />
/**
 * Top bar and chat header presentation: the Studio connection pill, the chat title in the header (the current chat shown in
 * the chat chip), the chip menu and header menu closing on an outside press, and the notice line under the header, which
 * shows a new status and then rests out of view. Display only: no requests, sends, grants or provider choices.
 */

/** The Studio pill's words. Green comes only from the current session state; nothing here infers a key or plugin problem. */
export const STUDIO_PILL_TEXT = Object.freeze({ paired: 'Studio connected', none: 'Studio not connected', unknown: 'Checking for Studio\u2026' });
export type StudioPillState = keyof typeof STUDIO_PILL_TEXT;
/** `live` is the workbench's own reading: a reported, non-revoked session with a recent heartbeat (null before the first read). */
export function studioPillState(live: boolean | null | undefined): StudioPillState {
  return live === true ? 'paired' : live === false ? 'none' : 'unknown';
}

/** The chip falls back to "Saved chats" when no chat is open; the header then names a new chat. */
export function chatHeaderTitle(chipLabel: string | null | undefined): string {
  const label = (chipLabel ?? '').replace(/\s+/g, ' ').trim();
  return !label || label === 'Saved chats' ? 'New chat' : label;
}

/** How long a new status line stays in view before it rests (it stays while hovered, focused or carrying Review / Details). */
export const NOTICE_REST_MS = 10000;
export type NoticeLineState = 'empty' | 'shown' | 'rest';

export interface WorkspaceTopbarOptions {
  workbench?: { studioConnected(): boolean | null; subscribeStudioChange(listener: () => void): () => void } | null;
  timers?: { set(callback: () => void, milliseconds: number): unknown; clear(handle: unknown): void };
  noticeRestMs?: number;
}
export interface WorkspaceTopbar { stop(): void; resume(): void; cleanup(): void }

export function startWorkspaceTopbar(doc: Document, options: WorkspaceTopbarOptions = {}): WorkspaceTopbar {
  const timers = options.timers ?? { set: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds), clear: (handle: unknown) => clearTimeout(handle as number) };
  const restMs = options.noticeRestMs ?? NOTICE_REST_MS;
  const removers: (() => void)[] = [];
  let stopped = false, disposed = false;
  const listen = (target: EventTarget | null | undefined, type: string, listener: (event: Event) => void, capture = false) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, listener, capture); removers.push(() => target.removeEventListener(type, listener, capture));
  };
  const topbar = doc.getElementById('workspace-topbar');

  // ---- Studio connection pill: green only while the current session state says paired; neutral otherwise. ----
  const pill = doc.getElementById('studio-connection-pill');
  const paintStudio = () => {
    if (!pill || disposed) return;
    let live: boolean | null = null;
    if (!stopped) { try { live = options.workbench?.studioConnected() ?? null; } catch { live = null; } }
    const state = studioPillState(live), text = STUDIO_PILL_TEXT[state];
    pill.classList.toggle('studio-connection-pill--paired', state === 'paired');
    pill.classList.toggle('studio-connection-pill--neutral', state !== 'paired');
    if (pill.getAttribute('data-studio') !== state) pill.setAttribute('data-studio', state);
    pill.setAttribute('aria-label', text + '. Open Studio settings.');
    pill.title = text;
  };
  if (options.workbench) { try { removers.push(options.workbench.subscribeStudioChange(paintStudio)); } catch { /* The pill stays neutral. */ } }

  // ---- Header title: the current chat of the chip the shown provider owns. ----
  const heading = doc.getElementById('codex-heading');
  const shownChip = (): HTMLDetailsElement | null => {
    for (const menu of Array.from(topbar?.querySelectorAll<HTMLDetailsElement>('.chat-tabs-history') ?? [])) if (!menu.hidden && !menu.closest('[hidden]')) return menu;
    return null;
  };
  const paintTitle = () => {
    if (!heading || disposed) return;
    const title = chatHeaderTitle(shownChip()?.querySelector('summary .chat-switch-current')?.textContent);
    if (heading.textContent !== title) heading.textContent = title;
    if (heading.getAttribute('title') !== title) heading.setAttribute('title', title);
  };

  // ---- Menus: the chat chip's sheet and the header's "more" menu close on an outside press or a choice. ----
  const more = doc.getElementById('chat-head-more') as HTMLDetailsElement | null;
  const openMenus = (): HTMLDetailsElement[] => [...Array.from(topbar?.querySelectorAll<HTMLDetailsElement>('.chat-tabs-history[open]') ?? []), ...(more?.open ? [more] : [])];
  listen(doc, 'pointerdown', event => {
    const target = event.target as Node | null;
    for (const menu of openMenus()) if (!target || !menu.contains(target)) menu.open = false;
  }, true);
  // A saved chat opens from the chip menu: close the sheet (Delete keeps it open for its second click).
  listen(topbar, 'click', event => {
    const button = (event.target as Element | null)?.closest?.('button');
    const menu = button?.parentElement;
    if (button && menu?.tagName === 'DETAILS' && menu.classList.contains('chat-tabs-history') && !button.classList.contains('claude-chat-delete')) (menu as HTMLDetailsElement).open = false;
  });
  listen(more, 'click', event => { if ((event.target as Element | null)?.closest?.('.chat-head-menu button')) queueMicrotask(() => { if (more) more.open = false; }); });
  listen(more, 'keydown', event => {
    if ((event as KeyboardEvent).key !== 'Escape' || !more?.open) return;
    event.preventDefault(); more.open = false; more.querySelector<HTMLElement>('summary')?.focus();
  });

  // ---- Notice line: a new status shows, then rests out of view (still announced and readable by assistive tech). ----
  const topline = doc.querySelector<HTMLElement>('#codex-panel .chat-topline');
  const notices = ['codex-notice', 'claude-chat-notice'].map(id => doc.getElementById(id)).filter((node): node is HTMLElement => !!node);
  const actions = doc.getElementById('codex-notice-actions');
  let lastNotice = '', restTimer: unknown = null;
  const clearRest = () => { if (restTimer !== null) { timers.clear(restTimer); restTimer = null; } };
  const setLine = (state: NoticeLineState) => { if (topline && topline.getAttribute('data-notice') !== state) topline.setAttribute('data-notice', state); };
  const sticky = () => !!actions && !actions.hidden && !doc.getElementById('codex-notice')?.hidden;
  const engaged = () => { try { return !!topline?.matches(':hover, :focus-within'); } catch { return false; } };
  const rest = () => {
    restTimer = null;
    if (stopped || disposed) return;
    if (sticky() || engaged()) { restTimer = timers.set(rest, restMs); return; }
    setLine('rest');
  };
  const paintNotice = () => {
    if (!topline || disposed) return;
    const node = notices.find(item => !item.hidden && (item.textContent ?? '').trim()), text = node?.textContent?.trim() ?? '';
    if (!text) { clearRest(); lastNotice = ''; setLine('empty'); return; }
    // The routine "working" line (queued messages already show as rows) never takes the line; it stays announced.
    if (node?.getAttribute('data-routine') === 'working' && !sticky()) { clearRest(); lastNotice = text; setLine('rest'); return; }
    if (text !== lastNotice || sticky()) { lastNotice = text; setLine('shown'); clearRest(); if (!stopped) restTimer = timers.set(rest, restMs); }
  };

  // One observer keeps the title, the notice line and the chip-driven state in step with what the chats render.
  let scheduled = false;
  const paint = () => { scheduled = false; if (disposed) return; paintTitle(); paintNotice(); };
  const schedule = () => { if (scheduled || disposed) return; scheduled = true; queueMicrotask(paint); };
  const View = doc.defaultView?.MutationObserver ?? (typeof MutationObserver === 'function' ? MutationObserver : null);
  const observer = View ? new View(schedule) : null;
  const observe = () => {
    if (!observer) return;
    const config = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'open', 'data-routine'] };
    if (topbar) observer.observe(topbar, config);
    if (topline) observer.observe(topline, config);
  };
  observe(); paintStudio(); paint();

  return {
    stop() { if (disposed) return; stopped = true; clearRest(); paintStudio(); },
    resume() { if (disposed || !stopped) return; stopped = false; paintStudio(); paint(); },
    cleanup() {
      if (disposed) return;
      disposed = true; stopped = true; clearRest(); observer?.disconnect();
      for (const remove of removers.splice(0)) { try { remove(); } catch { /* Already removed. */ } }
    },
  };
}
