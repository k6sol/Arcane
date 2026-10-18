/// <reference lib="dom" />
import type { CodexChat, ReplyUsageInput } from './codex-chat.js';
import { WORKSPACE_COMPACT_EVENT, WORKSPACE_COMPACT_RESTORE_EVENT } from './workspace-shell.js';
import { COST_CURRENCIES, TaskUsageTracker, USAGE_PRICES_AS_OF, compactTokenCount, costLocale, currencyForLocale, estimateUsageUsd, formatUsageCost, readCostPreferences, type CostDisplayPreferences, type TaskUsageCostDisplay } from './task-usage.js';

export interface TaskUsageFooterOptions {
  now?: () => number;
  /** Returns cleanup for one bounded presentation timer; never a native action. */
  schedule?: (callback: () => void, milliseconds: number) => () => void;
}

/** Read-only presentation. No requests, provider selection, grants or billing. */
export function startTaskUsageFooter(
  doc: Document,
  source: Pick<CodexChat, 'currentStateView' | 'subscribeStateChange'> & Partial<Pick<CodexChat, 'setReplyUsage' | 'replyUsageChanged'>>,
  options: TaskUsageFooterOptions = {},
) {
  const stopDisplay = startDisplayPreferences(doc);
  const field = doc.getElementById('codex-task-usage');
  if (!field) return { stop() {}, resume() {}, cleanup() { stopDisplay(); } };
  const tracker = new TaskUsageTracker(options.now);
  // Per-reply usage lines in the ChatGPT transcript, matching the Claude chat's.
  source.setReplyUsage?.(usage => codexReplyUsageView(usage, costDisplay(doc)));
  const offPreferences = onCostPreferences(doc, () => { render(); source.replyUsageChanged?.(); });
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
      tracker.costDisplay = costDisplay(doc);
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
    cleanup() { offPreferences(); stopDisplay(); source.setReplyUsage?.(null); disposed = true; stopped = true; clearTimer(); tracker.clear(); removeStateListener?.(); removeStateListener = null; hide(); },
  };
}

// ---- Cost display preferences (presentation only; estimates are never charges) ----
export const COST_PREFERENCES_KEY = 'arcane.cost-display.v1';
export const COST_PREFERENCES_EVENT = 'arcane:costpreferences';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
function preferenceStorage(doc: Document): PreferenceStorage | null { try { return doc?.defaultView?.localStorage ?? null; } catch { return null; } }
/** The viewer's formatting locale (navigator language when valid). */
export function viewerLocale(doc: Document): string { try { return costLocale(doc?.defaultView?.navigator?.language); } catch { return 'en-US'; } }
/** Stored preferences; the default currency follows the locale, and without a rate costs stay in USD. */
export function loadCostPreferences(doc: Document, storage: PreferenceStorage | null = preferenceStorage(doc)): CostDisplayPreferences {
  let stored: unknown = null;
  try { stored = JSON.parse(storage?.getItem(COST_PREFERENCES_KEY) ?? 'null'); } catch { stored = null; }
  return readCostPreferences(stored, currencyForLocale(viewerLocale(doc)));
}
export function costDisplay(doc: Document, storage?: PreferenceStorage | null): TaskUsageCostDisplay {
  return { preferences: storage === undefined ? loadCostPreferences(doc) : loadCostPreferences(doc, storage), locale: viewerLocale(doc) };
}
/** Saves preferences and tells every cost view to re-render. Returns false when storage is unavailable (the change still applies this session). */
export function saveCostPreferences(doc: Document, preferences: CostDisplayPreferences, storage: PreferenceStorage | null = preferenceStorage(doc)): boolean {
  const clean = readCostPreferences(preferences, preferences.currency);
  let saved = false;
  try { storage?.setItem(COST_PREFERENCES_KEY, JSON.stringify(clean)); saved = !!storage; } catch { saved = false; }
  try { const View = doc.defaultView?.CustomEvent ?? (typeof CustomEvent === 'function' ? CustomEvent : null); if (View && typeof doc.dispatchEvent === 'function') doc.dispatchEvent(new View(COST_PREFERENCES_EVENT)); } catch { /* Views refresh on their next render. */ }
  return saved;
}
/** Subscribes to preference changes; returns the unsubscribe. */
export function onCostPreferences(doc: Document, listener: () => void): () => void {
  if (typeof doc?.addEventListener !== 'function') return () => {};
  const handler = () => { try { listener(); } catch { /* Observers cannot break each other. */ } };
  doc.addEventListener(COST_PREFERENCES_EVENT, handler);
  return () => doc.removeEventListener(COST_PREFERENCES_EVENT, handler);
}
/** Text for one reply's usage line: '12k tokens (~$0.31)', or tokens only when the cost is unknown or hidden. */
export function replyUsageText(tokens: number, usd: number | null, display: TaskUsageCostDisplay): string {
  const count = Math.round(tokens), label = compactTokenCount(count) + (count === 1 ? ' token' : ' tokens');
  return usd !== null && display.preferences.show ? label + ' (' + formatUsageCost(usd, display.preferences, display.locale) + ')' : label;
}
/** A finished ChatGPT reply's usage line and tooltip: tokens, and the price-table estimate when the model is known. */
export function codexReplyUsageView(usage: ReplyUsageInput, display: TaskUsageCostDisplay): { text: string; title: string } {
  const usd = usage.model ? estimateUsageUsd(usage.model, usage) : null, format = (n: number) => Math.round(n).toLocaleString('en-US');
  const counts = format(usage.tokens) + ' tokens (' + format(usage.inputTokens) + ' input, ' + format(usage.cachedInputTokens) + ' of them cached, ' + format(usage.outputTokens) + ' output).';
  const title = usd === null || !display.preferences.show ? counts + (usd === null ? ' No cost estimate is available for this model.' : '')
    : counts + ' ' + formatUsageCost(usd, display.preferences, display.locale) + ' is estimated from Arcane\'s price table (' + USAGE_PRICES_AS_OF + '). Your ChatGPT plan is not charged per token.' +
      (display.preferences.currency !== 'USD' && display.preferences.rate !== null ? ' Converted at your rate of ' + display.preferences.rate + ' ' + display.preferences.currency + ' per USD.' : '');
  return { text: replyUsageText(usage.tokens, usd, display), title };
}

/** Binds the Settings > General > Display cost controls (#cost-show, #cost-currency, #cost-rate). Returns cleanup. */
export function bindCostSettings(doc: Document): () => void {
  const show = doc.getElementById?.('cost-show') as HTMLInputElement | null, currency = doc.getElementById?.('cost-currency') as HTMLSelectElement | null;
  const rate = doc.getElementById?.('cost-rate') as HTMLInputElement | null, note = doc.getElementById?.('cost-settings-note');
  if (!show || !currency || !rate) return () => {};
  if (!currency.options?.length) for (const code of COST_CURRENCIES) { const option = doc.createElement('option'); option.value = code; option.textContent = code; currency.append(option); }
  const sync = () => {
    const prefs = loadCostPreferences(doc);
    show.checked = prefs.show; currency.value = prefs.currency; rate.value = prefs.rate === null ? '' : String(prefs.rate);
    const usd = prefs.currency === 'USD';
    rate.disabled = usd || !prefs.show; currency.disabled = !prefs.show;
    rate.setAttribute('aria-describedby', 'cost-settings-note');
    if (note) note.textContent = !prefs.show ? 'Cost estimates are hidden. Token counts still show.'
      : usd ? 'Costs show in US dollars.'
      : prefs.rate === null ? 'Enter how many ' + prefs.currency + ' equal 1 USD to show ' + prefs.currency + '. Until then costs show in US dollars.'
      : 'Costs show in ' + prefs.currency + ' at your rate of ' + prefs.rate + ' per USD (' + formatUsageCost(1, prefs, viewerLocale(doc)).slice(1) + ' for $1.00).';
  };
  const save = () => {
    const raw = rate.value.trim(), parsed = raw === '' ? null : Number(raw.replace(',', '.'));
    if (parsed !== null && !(Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000)) { if (note) note.textContent = 'Enter a rate greater than 0, for example 0.92.'; return; }
    saveCostPreferences(doc, { show: show.checked, currency: currency.value, rate: parsed });
    sync();
  };
  sync();
  const changeCurrency = () => { rate.value = ''; save(); };
  show.addEventListener('change', save); currency.addEventListener('change', changeCurrency); rate.addEventListener('change', save);
  return () => { show.removeEventListener('change', save); currency.removeEventListener('change', changeCurrency); rate.removeEventListener('change', save); };
}

/** Compact ("thin") sidebar choice, kept on this device. */
export const SIDEBAR_COMPACT_KEY = 'arcane.sidebar.compact.v1';
/**
 * Display preferences owner: binds the cost settings and keeps the compact sidebar choice on this device.
 * The workspace shell stays storage-free; it announces changes and applies restores. Returns cleanup.
 */
export function startDisplayPreferences(doc: Document): () => void {
  const removers = [bindCostSettings(doc)], storage = preferenceStorage(doc);
  let compact = false;
  try { compact = storage?.getItem(SIDEBAR_COMPACT_KEY) === 'true'; } catch { compact = false; }
  if (compact) {
    doc.getElementById?.('app-sidebar')?.classList?.add('compact'); doc.body?.classList?.add('shell-compact');
    try { const View = doc.defaultView?.CustomEvent ?? (typeof CustomEvent === 'function' ? CustomEvent : null); if (View && typeof doc.dispatchEvent === 'function') doc.dispatchEvent(new View(WORKSPACE_COMPACT_RESTORE_EVENT, { detail: { compact } })); } catch { /* A shell started later reads the page state. */ }
  }
  if (typeof doc?.addEventListener === 'function') {
    const save = (event: Event) => { const detail = (event as CustomEvent).detail as { compact?: unknown } | null; if (typeof detail?.compact === 'boolean') try { storage?.setItem(SIDEBAR_COMPACT_KEY, String(detail.compact)); } catch { /* Applies for this session. */ } };
    doc.addEventListener(WORKSPACE_COMPACT_EVENT, save); removers.push(() => doc.removeEventListener(WORKSPACE_COMPACT_EVENT, save));
  }
  return () => { for (const remove of removers.splice(0)) remove(); };
}
