/// <reference lib="dom" />
import type { CodexChat } from './codex-chat.js';
import { TaskUsageTracker } from './task-usage.js';

export interface TaskUsageFooterOptions {
  now?: () => number;
  /** Returns cleanup for one bounded presentation timer; never a native action. */
  schedule?: (callback: () => void, milliseconds: number) => () => void;
}

/** Read-only presentation. No requests, provider selection, grants or billing. */
export function startTaskUsageFooter(
  doc: Document,
  source: Pick<CodexChat, 'currentStateView' | 'subscribeStateChange'>,
  options: TaskUsageFooterOptions = {},
) {
  const field = doc.getElementById('codex-task-usage');
  if (!field) return { stop() {}, resume() {}, cleanup() {} };
  const tracker = new TaskUsageTracker(options.now);
  const schedule = options.schedule ?? ((callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  });
  let cancelTimer: (() => void) | null = null;
  let removeStateListener: (() => void) | null = null;
  let stopped = false, disposed = false;
  // A visual second-by-second clock must not repeatedly interrupt screen readers.
  field.setAttribute('aria-live', 'off');
  const clearTimer = () => { cancelTimer?.(); cancelTimer = null; };
  const hide = () => {
    field.hidden = true; field.textContent = '';
    field.removeAttribute('aria-label'); field.removeAttribute('title');
  };
  const render = () => {
    clearTimer();
    if (stopped || disposed) return;
    try {
      const current = source.currentStateView();
      const state = current.state;
      const snapshot = current.fresh && !current.switching && current.nativeBoundToActiveChat ? state?.snapshot ?? null : null;
      const view = tracker.read({ projectId: state?.projectPath ?? '', snapshot });
      field.hidden = !view.footer.visible;
      field.textContent = view.footer.text;
      if (view.footer.visible) {
        field.setAttribute('aria-label', view.footer.accessibleLabel);
        if (view.footer.detail) field.setAttribute('title', view.footer.detail);
        else field.removeAttribute('title');
      } else {
        field.removeAttribute('aria-label'); field.removeAttribute('title');
      }
      if (view.active) cancelTimer = schedule(render, 1000);
    } catch { tracker.clear(); hide(); }
  };
  const subscribe = () => { if (!removeStateListener) removeStateListener = source.subscribeStateChange(render); };
  subscribe(); render();
  return {
    stop() { stopped = true; clearTimer(); tracker.clear(); removeStateListener?.(); removeStateListener = null; hide(); },
    resume() { if (disposed) return; stopped = false; subscribe(); render(); },
    cleanup() { disposed = true; stopped = true; clearTimer(); tracker.clear(); removeStateListener?.(); removeStateListener = null; hide(); },
  };
}
