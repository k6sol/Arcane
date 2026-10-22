/// <reference lib="dom" />
import type { CodexChat, ReplyUsageInput } from './codex-chat.js';
import { WORKSPACE_COMPACT_EVENT, WORKSPACE_COMPACT_RESTORE_EVENT } from './workspace-shell.js';
import { COST_CURRENCIES, TaskUsageTracker, USAGE_PRICES_AS_OF, compactTokenCount, costConversion, costConversionNote, costLocale, currencyForLocale, estimateUsageUsd, formatUsageCost, readCostPreferences, type CostDisplayPreferences, type TaskUsageCostDisplay, type TaskUsageView } from './task-usage.js';

export interface TaskUsageFooterOptions {
  now?: () => number;
  /** Returns cleanup for one bounded presentation timer; never a native action. */
  schedule?: (callback: () => void, milliseconds: number) => () => void;
  /** Each rendered usage view (null when hidden), for read-only composer presentation such as the context ring. */
  onView?: (view: TaskUsageView | null) => void;
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
      try { options.onView?.(view); } catch { /* Composer observers never affect this footer. */ }
    } catch { tracker.clear(); hide(); try { options.onView?.(null); } catch { /* Presentation only. */ } }
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
/** Text for one reply's usage line: '12k tokens · ~$0.31', or tokens only when the cost is unknown or hidden. */
export function replyUsageText(tokens: number, usd: number | null, display: TaskUsageCostDisplay): string {
  const count = Math.round(tokens), label = compactTokenCount(count) + (count === 1 ? ' token' : ' tokens');
  return usd !== null && display.preferences.show ? label + ' · ' + formatUsageCost(usd, display.preferences, display.locale) : label;
}
/** A finished ChatGPT reply's usage line and tooltip: tokens, and the price-table estimate when the model is known. */
export function codexReplyUsageView(usage: ReplyUsageInput, display: TaskUsageCostDisplay): { text: string; title: string; rows: [string, string][]; note: string | null } {
  const usd = usage.model ? estimateUsageUsd(usage.model, usage) : null, format = (n: number) => Math.round(n).toLocaleString('en-US');
  const counts = format(usage.tokens) + ' tokens (' + format(usage.inputTokens) + ' input, ' + format(usage.cachedInputTokens) + ' of them cached, ' + format(usage.outputTokens) + ' output).';
  const note = usd === null || !display.preferences.show ? (usd === null ? 'No cost estimate is available for this model.' : null)
    : formatUsageCost(usd, display.preferences, display.locale) + ' is estimated from Arcane\'s price table (' + USAGE_PRICES_AS_OF + '). Your ChatGPT plan is not charged per token.' +
      costConversionNote(display.preferences);
  // The hover/focus breakdown under the line: exact counts, then where the cost came from.
  const rows: [string, string][] = [['Input', format(usage.inputTokens)], ['Cached', format(usage.cachedInputTokens)], ['Output', format(usage.outputTokens)]];
  return { text: replyUsageText(usage.tokens, usd, display), title: counts + (note ? ' ' + note : ''), rows, note };
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
      : costConversion(prefs).source === 'reference' ? 'Costs show in ' + prefs.currency + ' at an approximate rate of ' + costConversion(prefs).rate + ' per USD (' + formatUsageCost(1, prefs, viewerLocale(doc)).slice(1) + ' for $1.00). Enter your own rate to replace it.'
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

// ---- C30 composer chrome: Pyx perch, agents count, context ring, closed model chip, placeholder, queue card placement ----
// Read-only presentation over state the chat hosts already render or expose. No requests, sends, grants, storage or
// provider changes. Pyx motion (frame swaps, a 1px bob) runs only under prefers-reduced-motion: no-preference.
export type ComposerSurface = 'codex' | 'claude' | 'arcane';
export type PyxMood = 'idle' | 'listening' | 'working' | 'done' | 'alert';
export interface ComposerSubagent { readonly name: string; readonly task: string; readonly state: 'started' | 'finished' | 'failed' }
export interface ComposerContextWindow { readonly usedTokens: number; readonly windowTokens: number }
export interface ComposerChromeOptions {
  surface?: () => ComposerSurface;
  subscribeSurface?: (listener: () => void) => () => void;
  /** null before the first Studio session read; false when no live paired Studio session. */
  studioConnected?: () => boolean | null;
  subscribeStudio?: (listener: () => void) => () => void;
  /** Sub-agents of the shown chat's latest turn (Claude Code Task/Agent calls). Absent or empty hides the count. */
  subagents?: () => readonly ComposerSubagent[];
  /** Context occupancy the active provider reports for this conversation; null hides the ring (no estimate is shown). */
  contextWindow?: () => ComposerContextWindow | null;
  /** The latest native turn failed (Codex task status); Claude/Arcane failures are read from the transcript. */
  turnFailed?: () => boolean;
  /** Provider mark for the closed model chip (codex-chat.ts providerLogo). */
  providerLogo?: (provider: ComposerSurface) => Element;
  /** Pyx pop-out (C23, root-owned host/IPC). Absent: the click only dispatches PYX_OPEN_EVENT on the document. */
  openPyx?: () => void;
  now?: () => number;
}
export interface ComposerChromeController { refresh(): void; mood(): PyxMood; stop(): void; resume(): void }
export const PYX_OPEN_EVENT = 'arcane:pyxopen';
export const COMPOSER_FOLLOW_UP_PLACEHOLDER = 'Ask for follow-up changes';
export const PYX_DONE_MS = 2400;
const PYX_STATUS: Record<Exclude<PyxMood, 'alert'>, string> = { idle: 'Pyx is resting', listening: 'Pyx is listening', working: 'Pyx is working', done: 'Pyx finished the turn' };
const CONTEXT_RING = 34.56; // 2πr for r = 5.5
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Closed-chip effort pips: low 1, medium 2, high and above 3; unknown efforts show no pips. */
export function composerEffortLevel(effort: string | null | undefined): 0 | 1 | 2 | 3 {
  const value = String(effort ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return value === 'minimal' || value === 'low' ? 1 : value === 'medium' ? 2 : ['high', 'xhigh', 'extrahigh', 'max'].includes(value) ? 3 : 0;
}
/** Whole percent of the context window left, or null without a reported window. */
export function composerContextLeft(context: ComposerContextWindow | null | undefined): number | null {
  if (!context || !Number.isFinite(context.windowTokens) || context.windowTokens <= 0 || !Number.isFinite(context.usedTokens) || context.usedTokens < 0) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - context.usedTokens / context.windowTokens))));
}
/** Codex reports the last request's tokens and the model's context window with each usage update (thread/tokenUsage/updated). */
export function codexContextWindow(view: TaskUsageView | null | undefined): ComposerContextWindow | null {
  const used = view?.lastRequest?.totalTokens, size = view?.modelContextWindow;
  return typeof used === 'number' && typeof size === 'number' && size > 0 ? { usedTokens: used, windowTokens: size } : null;
}

// Pyx sprite: the Claude Design ShardPet pixel maps (24×24), run-length encoded into rects. k outline, d dark red, r red, l light red, w white.
const PYX_PALETTE: Record<string, string> = { k: '#14040A', d: '#8E0F22', r: '#E5323F', l: '#FF6B78', w: '#FFFFFF' };
const CREST_BASE = ['......kwk.kllk.kwk......', '......klrkrllrkrlk......', '......krlrrllrrlrk......'];
const CREST_HOT = ['......kwk.kwlk.kwk......', '......klrkrllrkrlk......', '......krrlrllrlrrk......'];
const PYX_CRESTS: Record<string, readonly string[]> = {
  calm1: ['........................', '........................', '...........k............', '..........kwk...........', '.......k..kwlk..k.......', ...CREST_BASE],
  calm2: ['........................', '........................', '............k...........', '...........kwk..........', '......k...klwk..k.......', ...CREST_BASE],
  tall1: ['...........k............', '..........kwk...........', '.......k..kwk...k.......', '......kwk.kwlk.kwk......', '......klk.kllk.klk......', CREST_BASE[1]!, CREST_BASE[2]!, '......krrlrllrlrrk......'],
  tall2: ['............k...........', '...........kwk..........', '......k...kwlk...k......', '......kwk.kwlk.kwk......', '......klk.kllk.klk......', CREST_BASE[1]!, CREST_BASE[2]!, '......krrlrllrlrrk......'],
  blaze: ['...........k............', '..........kwk...........', '.......k..kwk...k.......', '......kwk.kwwk.kwk......', '......kwk.klwk.kwk......', ...CREST_HOT],
};
const PYX_BODY = ['......kkkkkkkkkkkk......', '.....klwwllllrrrddk.....', '....klwlllrrrrrrrdddk...', '...kllrrrrrrrrrrrdddk...', '...kllrrrrrrrrrrddddk...',
  '...klrrrrrrrrrrrrdddk...', '...klrrrrrrrrrrrddddk...', '...klrrrrrrrrrrrrdddk...', '...klrrrrrrrrrrdrdddk...', '....krrrrrrrrrdrddddk...', '.....krdrdrdrdddddk.....',
  '......kddddddddddk......', '.......kkkkkkkkkk.......'];
const PYX_FEET = ['......kddk....kddk......', '......kkkk....kkkk......'];
const ARM_DOWN = ['..k', 'kll', 'krr', 'kk.'], ARM_UP = ['kk..', 'klk.', 'kllk', '.kl.', '..k.'], ARM_OUT = ['kk.', 'rdk', 'kk.'], PYX_BLOCK = ['kkkk', 'kwlk', 'klrk', 'kkkk'];
const PYX_FACES: Record<Exclude<PyxMood, 'alert'>, readonly (readonly [number, number, string])[]> = {
  idle: [[7, 14, 'w'], [8, 14, 'k'], [7, 15, 'k'], [8, 15, 'k'], [15, 14, 'w'], [16, 14, 'k'], [15, 15, 'k'], [16, 15, 'k'], [10, 17, 'k'], [11, 18, 'k'], [12, 18, 'k'], [13, 17, 'k']],
  listening: [[7, 13, 'k'], [8, 13, 'w'], [7, 14, 'k'], [8, 14, 'k'], [7, 15, 'k'], [8, 15, 'k'], [15, 13, 'k'], [16, 13, 'w'], [15, 14, 'k'], [16, 14, 'k'], [15, 15, 'k'], [16, 15, 'k'],
    [11, 17, 'k'], [12, 17, 'k'], [11, 18, 'k'], [12, 18, 'k']],
  working: [[7, 12, 'k'], [8, 13, 'k'], [16, 12, 'k'], [15, 13, 'k'], [7, 14, 'w'], [8, 14, 'k'], [7, 15, 'k'], [8, 15, 'k'], [15, 14, 'w'], [16, 14, 'k'], [15, 15, 'k'], [16, 15, 'k'], [11, 17, 'k'], [12, 17, 'k']],
  done: [[6, 14, 'k'], [7, 13, 'k'], [8, 13, 'k'], [9, 14, 'k'], [14, 14, 'k'], [15, 13, 'k'], [16, 13, 'k'], [17, 14, 'k'], [10, 17, 'k'], [11, 17, 'd'], [12, 17, 'd'], [13, 17, 'k'], [11, 18, 'k'], [12, 18, 'k']],
};
/** One sprite frame as rects {x, y, w, fill} (height 1), exactly as ShardPet draws it. */
export function pyxSpritePixels(mood: Exclude<PyxMood, 'alert'>, frame: 1 | 2): { x: number; y: number; w: number; fill: string }[] {
  const grid: (string | null)[][] = Array.from({ length: 24 }, () => Array<string | null>(24).fill(null));
  const put = (x: number, y: number, c: string) => { if (c !== '.' && x >= 0 && x < 24 && y >= 0 && y < 24) grid[y]![x] = c; };
  const stamp = (rows: readonly string[], x0: number, y0: number) => rows.forEach((row, j) => row.split('').forEach((c, i) => put(x0 + i, y0 + j, c)));
  const dots = (list: readonly (readonly [number, number, string])[], dy: number) => list.forEach(([x, y, c]) => put(x, y + dy, c));
  const mirror = (rows: readonly string[]) => rows.map(s => s.split('').reverse().join('').replace(/r/g, 'd').replace(/l/g, 'r'));
  const cfg = { idle: { crest: frame === 2 ? 'calm2' : 'calm1', dy: frame === 2 ? 1 : 0, feet: 0 }, listening: { crest: 'calm1', dy: 0, feet: 0 },
    working: { crest: frame === 2 ? 'tall2' : 'tall1', dy: 0, feet: 0 }, done: { crest: 'blaze', dy: -1, feet: -1 } }[mood];
  const dy = cfg.dy;
  let crest = PYX_CRESTS[cfg.crest]!;
  if (mood === 'listening') crest = crest.map((s, i) => i >= 2 && i <= 5 ? '.' + s.slice(0, 23) : s);
  stamp(crest, 0, 1 + dy); stamp(PYX_FEET, 0, 22 + cfg.feet); stamp(PYX_BODY, 0, 9 + dy);
  if (mood === 'done') { stamp(ARM_UP, 0, 9 + dy); stamp(mirror(ARM_UP), 20, 9 + dy); }
  else if (mood === 'listening') { stamp(ARM_DOWN, 0, 14 + dy); stamp(mirror(ARM_UP), 20, 9 + dy); }
  else if (mood === 'working') { stamp(ARM_DOWN, 0, 14 + dy); stamp(ARM_OUT, 21, 13 + dy); stamp(PYX_BLOCK, 20, frame === 2 ? 8 : 9); }
  else { stamp(ARM_DOWN, 0, 14 + dy); stamp(mirror(ARM_DOWN), 21, 14 + dy); }
  dots(PYX_FACES[mood], dy); dots([[6, 16, 'l'], [17, 16, 'l']], dy);
  if (mood === 'done') dots([[5, 16, 'l'], [18, 16, 'l']], dy);
  if (mood === 'done') dots([[1, 3, 'w'], [0, 4, 'w'], [1, 4, 'w'], [2, 4, 'w'], [1, 5, 'w'], [22, 5, 'w'], [21, 6, 'w'], [22, 6, 'w'], [23, 6, 'w'], [22, 7, 'w'], [20, 1, 'l'], [3, 1, 'l']], 0);
  if (mood === 'idle') dots([frame === 2 ? [19, 1, 'l'] : [18, 2, 'l']], 0);
  if (mood === 'working') dots(frame === 2 ? [[19, 6, 'w'], [22, 5, 'w']] : [[20, 7, 'w'], [23, 6, 'w']], 0);
  const pixels: { x: number; y: number; w: number; fill: string }[] = [];
  grid.forEach((row, y) => { for (let x = 0; x < 24;) { const c = row[x]; if (!c) { x++; continue; } let w = 1; while (x + w < 24 && row[x + w] === c) w++; pixels.push({ x, y, w, fill: PYX_PALETTE[c]! }); x += w; } });
  return pixels;
}

/**
 * Composer chrome for the shared chat surface (#codex-compose). Adds the Pyx perch, the agents count and the context ring,
 * decorates the closed model chip (provider mark, effort pips), keeps the follow-up placeholder and moves the queue strips
 * (#codex-chat-queue / #claude-chat-queue, rendered by the chat hosts) to sit just above the composer. Everything it adds is
 * presentation; the chat hosts keep owning sending, queueing, steering and the model popovers.
 */
export function startComposerChrome(doc: Document, options: ComposerChromeOptions = {}): ComposerChromeController {
  const form = doc.getElementById('codex-compose'), input = doc.getElementById('codex-composer') as HTMLTextAreaElement | null;
  const controls = form?.querySelector?.<HTMLElement>('.composer-controls') ?? null;
  if (!form || !input || !controls || typeof doc.createElementNS !== 'function') return { refresh() {}, mood: () => 'idle', stop() {}, resume() {} };
  const win = doc.defaultView, now = options.now ?? (() => Date.now());
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  const icon = (viewBox: string, className: string, attributes: Record<string, string>, shapes: readonly (readonly [string, Record<string, string>])[]): SVGSVGElement => {
    const node = doc.createElementNS(SVG_NS, 'svg'); node.setAttribute('viewBox', viewBox); node.setAttribute('class', className);
    node.setAttribute('aria-hidden', 'true'); node.setAttribute('focusable', 'false');
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    for (const [tag, attrs] of shapes) { const child = doc.createElementNS(SVG_NS, tag); for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, value); node.append(child); }
    return node;
  };
  const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const surface = (): ComposerSurface => { try { const value = options.surface?.(); return value === 'claude' || value === 'arcane' ? value : 'codex'; } catch { return 'codex'; } };

  // Pyx perch: a 24×24 sprite drawn at 2x inside a 68px button on the composer's top-left edge.
  const pyx = make('button', 'pyx-perch pyx--idle'); pyx.type = 'button'; pyx.id = 'composer-pyx'; pyx.dataset.mood = 'idle';
  pyx.setAttribute('aria-label', 'Open Pyx'); pyx.setAttribute('aria-describedby', 'composer-pyx-status');
  if (options.openPyx) pyx.setAttribute('aria-haspopup', 'dialog');
  const body = make('span', 'pyx-perch__body');
  const sprite = icon('0 0 24 24', 'pyx-sprite', { width: '48', height: '48', 'shape-rendering': 'crispEdges' }, []);
  const badge = icon('0 0 5 9', 'pyx-badge', { width: '10', height: '18', 'shape-rendering': 'crispEdges' }, ([[0, 0, 5, 9, '#14040A'], [1, 1, 3, 7, '#E5323F'], [2, 2, 1, 3, '#FFFFFF'], [2, 6, 1, 1, '#FFFFFF']] as const)
    .map(([x, y, width, height, fill]) => ['rect', { x: String(x), y: String(y), width: String(width), height: String(height), fill }] as const));
  body.append(sprite); pyx.append(body, badge);
  const status = make('span', 'visually-hidden', PYX_STATUS.idle); status.id = 'composer-pyx-status';
  const frames = new Map<string, SVGGElement>();
  const spriteFrame = (mood: Exclude<PyxMood, 'alert'>, frame: 1 | 2): SVGGElement => {
    const key = mood + frame; let group = frames.get(key);
    if (!group) {
      group = doc.createElementNS(SVG_NS, 'g') as SVGGElement;
      for (const p of pyxSpritePixels(mood, frame)) { const rect = doc.createElementNS(SVG_NS, 'rect'); rect.setAttribute('x', String(p.x)); rect.setAttribute('y', String(p.y)); rect.setAttribute('width', String(p.w)); rect.setAttribute('height', '1'); rect.setAttribute('fill', p.fill); group.append(rect); }
      frames.set(key, group);
    }
    return group;
  };
  const openPyx = (event: Event) => {
    event.preventDefault();
    if (options.openPyx) { try { options.openPyx(); } catch { /* The pop-out host owns its own errors. */ } return; }
    try { const View = win?.CustomEvent ?? (typeof CustomEvent === 'function' ? CustomEvent : null); if (View) doc.dispatchEvent(new View(PYX_OPEN_EVENT, { detail: { mood } })); } catch { /* No pop-out yet. */ }
  };

  // Agents count with a hover/focus list; hidden while the latest turn started none.
  const agents = make('span', 'composer-pop-anchor composer-agents'); agents.hidden = true;
  const agentsButton = make('button', 'composer-agents-button'); agentsButton.type = 'button'; agentsButton.id = 'composer-agents'; agentsButton.setAttribute('aria-describedby', 'composer-agents-pop');
  const agentsCount = make('span', 'composer-agents-count'), agentsWord = make('span', 'composer-agents-word');
  agentsButton.append(icon('0 0 24 24', 'composer-agents-icon', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8' }, [[8, 9], [16, 9], [12, 16]].map(([cx, cy]) => ['circle', { cx: String(cx), cy: String(cy), r: '3.2' }] as const)), agentsCount, agentsWord);
  const agentsPop = make('span', 'composer-pop composer-agents-pop'); agentsPop.id = 'composer-agents-pop'; agentsPop.setAttribute('role', 'tooltip');
  agents.append(agentsButton, agentsPop);

  // Context ring: % of the reported context window left, with the exact counts on hover/focus. White-on-red under 15%.
  const context = make('span', 'composer-pop-anchor composer-context'); context.hidden = true;
  const contextButton = make('button', 'composer-context-button'); contextButton.type = 'button'; contextButton.id = 'composer-context'; contextButton.setAttribute('aria-describedby', 'composer-context-pop');
  const ring = icon('0 0 14 14', 'composer-context-ring', { width: '14', height: '14' }, [['circle', { class: 'composer-context-track', cx: '7', cy: '7', r: '5.5', fill: 'none', 'stroke-width': '2' }],
    ['circle', { class: 'composer-context-arc', cx: '7', cy: '7', r: '5.5', fill: 'none', 'stroke-width': '2', 'stroke-dasharray': CONTEXT_RING.toFixed(2) }]]);
  const arc = ring.lastElementChild!, contextLabel = make('span', 'composer-context-label');
  contextButton.append(ring, contextLabel);
  const contextPop = make('span', 'composer-pop composer-context-pop'); contextPop.id = 'composer-context-pop'; contextPop.setAttribute('role', 'tooltip');
  const contextHead = make('span', 'composer-context-head'), contextBar = make('span', 'composer-context-bar'), contextFill = make('span', 'composer-context-fill');
  const contextMeta = make('span', 'composer-context-meta'), contextUsed = make('span', 'composer-context-used'), contextLeft = make('span', 'composer-context-left');
  contextBar.append(contextFill); contextMeta.append(contextUsed, contextLeft); contextPop.append(contextHead, contextBar, contextMeta); context.append(contextButton, contextPop);

  form.prepend(pyx, status); controls.append(agents, context);
  const defaultPlaceholder = (input.dataset.steerHint === 'true' ? input.dataset.placeholder : input.placeholder) || 'What would you like to build?';

  let mood: PyxMood = 'idle', alertText = '', wasWorking = false, doneUntil = 0, tick = 0, shownFrame = '', agentsSignature = '', contextSignature = '';
  let pending = false, stopped = false, animation: ReturnType<typeof setTimeout> | undefined, doneTimer: ReturnType<typeof setTimeout> | undefined;
  const removers: (() => void)[] = [];
  const motion = (): boolean => { try { return !!win?.matchMedia?.('(prefers-reduced-motion: no-preference)').matches && !doc.hidden; } catch { return false; } };

  /** The queue strips are created inside the form by the chat hosts; the card sits just above the composer instead. */
  const placeQueues = () => {
    if (typeof form.before !== 'function') return;
    for (const node of Array.from(form.children)) if (node.classList?.contains('queue-strip')) { form.before(node); observeQueue(node); }
  };
  const queueIcons: Record<string, () => SVGSVGElement> = {
    'queue-list-icon': () => icon('0 0 24 24', 'queue-icon', stroke, ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'].map(d => ['path', { d }] as const)),
    'queue-steer': () => icon('0 0 24 24', 'queue-icon', { ...stroke, 'stroke-width': '2' }, [['path', { d: 'M5 5v6a4 4 0 0 0 4 4h10' }], ['path', { d: 'm15 11 4 4-4 4' }]]),
    'queue-remove': () => icon('0 0 24 24', 'queue-icon', stroke, [['path', { d: 'M4 7h16' }], ['path', { d: 'M9 7V4.5h6V7' }], ['path', { d: 'M6 7l1 13h10l1-13' }]]),
    'queue-menu-toggle': () => icon('0 0 24 24', 'queue-icon', { fill: 'currentColor' }, [[5, 12], [12, 12], [19, 12]].map(([cx, cy]) => ['circle', { cx: String(cx), cy: String(cy), r: '1.6' }] as const)),
  };
  /** Row glyphs become the canvas icons; labels, roles and handlers stay exactly as the queue renderer made them. */
  const decorateQueues = () => {
    for (const strip of Array.from(doc.querySelectorAll<HTMLElement>('.queue-strip'))) for (const row of Array.from(strip.querySelectorAll<HTMLElement>('.queue-row'))) {
      for (const [className, build] of Object.entries(queueIcons)) {
        const node = row.querySelector<HTMLElement>(':scope > .' + className);
        if (!node || node.querySelector('svg.queue-icon')) continue;
        if (className === 'queue-steer') { const label = make('span', 'queue-steer-label'); label.append(...Array.from(node.childNodes)); node.replaceChildren(build(), label); }
        else node.replaceChildren(build());
      }
      const state = row.querySelector<HTMLElement>(':scope > .queue-status'); if (state) state.dataset.plain = String(row.dataset.queueState === 'queued' && state.textContent === 'Queued');
    }
  };
  const decorateChip = () => {
    const trigger = doc.getElementById('codex-model-trigger'), effort = doc.getElementById('codex-effort-label');
    if (!trigger || !effort) return;
    const provider = surface(), logo = trigger.querySelector(':scope > .provider-logo');
    if (options.providerLogo && logo?.getAttribute('data-provider') !== provider) {
      try { const next = options.providerLogo(provider); if (logo) logo.replaceWith(next); else trigger.prepend(next); } catch { /* The model name remains. */ }
    }
    let pips = trigger.querySelector<HTMLElement>(':scope > .effort-pips');
    if (!pips) { pips = make('span', 'effort-pips'); pips.setAttribute('aria-hidden', 'true'); pips.append(make('span', 'effort-pip'), make('span', 'effort-pip'), make('span', 'effort-pip')); effort.before(pips); }
    const level = effort.hidden ? 0 : composerEffortLevel(effort.textContent);
    if (level) { if (trigger.dataset.effortLevel !== String(level)) trigger.dataset.effortLevel = String(level); } else if (trigger.dataset.effortLevel) delete trigger.dataset.effortLevel;
    if (pips.hidden !== !level) pips.hidden = !level;
    // The capitalised word is drawn from data-word (CSS ::before); the host's label keeps the exact effort text for assistive tech.
    let word = trigger.querySelector<HTMLElement>(':scope > .effort-word');
    if (!word) { word = make('span', 'effort-word'); word.setAttribute('aria-hidden', 'true'); effort.after(word); }
    const text = (effort.textContent ?? '').trim(), shown = effort.hidden ? '' : text.charAt(0).toUpperCase() + text.slice(1);
    if (word.dataset.word !== shown) word.dataset.word = shown;
    if (word.hidden !== !shown) word.hidden = !shown;
  };
  /** A chat with history asks for follow-up changes; while a steerable reply runs the same text replaces the hidden queue hint. */
  const renderPlaceholder = (history: boolean) => {
    const wanted = history ? COMPOSER_FOLLOW_UP_PLACEHOLDER : defaultPlaceholder;
    if (input.dataset.steerHint === 'true' && input.dataset.placeholder !== wanted) input.dataset.placeholder = wanted;
    if (input.placeholder !== wanted) input.placeholder = wanted;
  };
  const renderAgents = (list: readonly ComposerSubagent[]) => {
    const signature = JSON.stringify(list); if (signature === agentsSignature) return; agentsSignature = signature;
    agents.hidden = !list.length; if (!list.length) { agentsPop.replaceChildren(); return; }
    const n = list.length, running = list.filter(agent => agent.state === 'started').length;
    agentsCount.textContent = String(n); agentsWord.textContent = n === 1 ? 'agent' : 'agents';
    agentsButton.setAttribute('aria-label', n + (n === 1 ? ' agent, ' : ' agents, ') + running + ' running. Show agents');
    agentsPop.replaceChildren(make('span', 'composer-pop-title', 'Agents in this turn'), ...list.map(agent => {
      const state = agent.state === 'started' ? 'running' : agent.state === 'failed' ? 'failed' : 'done', row = make('span', 'composer-agent'); row.dataset.state = state;
      const mark = state === 'running' ? make('span', 'composer-agent-live') : icon('0 0 24 24', 'composer-agent-mark', { ...stroke, 'stroke-width': '2.2' }, [['path', { d: state === 'failed' ? 'M7 7l10 10M17 7 7 17' : 'm5 12.5 4.5 4.5L19 7.5' }]]);
      const text = make('span', 'composer-agent-text'); text.append(make('span', 'composer-agent-name', agent.name));
      if (agent.task) text.append(make('span', 'composer-agent-task', agent.task));
      row.append(mark, text, make('span', 'composer-agent-status', state === 'running' ? 'Running' : state === 'failed' ? 'Failed' : 'Done'));
      return row;
    }));
  };
  const renderContext = (value: ComposerContextWindow | null) => {
    const left = composerContextLeft(value), signature = left === null || !value ? '' : JSON.stringify([value.usedTokens, value.windowTokens]);
    if (signature === contextSignature) return; contextSignature = signature;
    context.hidden = left === null; if (left === null || !value) return;
    const low = left < 15, locale = viewerLocale(doc), count = (n: number) => Math.round(n).toLocaleString(locale);
    context.dataset.low = String(low);
    contextLabel.textContent = left + '% left';
    contextButton.setAttribute('aria-label', 'Context: ' + left + '% left' + (low ? ', running low' : '') + '. Show details');
    arc.setAttribute('stroke-dashoffset', (CONTEXT_RING * left / 100).toFixed(2));
    contextHead.textContent = low ? 'This chat is close to its context limit' : 'Context used by this chat';
    contextFill.style.transform = 'scaleX(' + ((100 - left) / 100).toFixed(3) + ')';
    contextUsed.replaceChildren(make('strong', undefined, count(Math.min(value.usedTokens, value.windowTokens))), ' / ' + count(value.windowTokens) + ' tokens');
    contextLeft.textContent = left + '% left';
  };
  /** The last user/assistant/error article decides (error articles may sit inside the build progress group): an error
   *  article (Claude, Arcane) means the turn did not finish. */
  const transcriptFailed = (): boolean => {
    const box = doc.getElementById('codex-messages'); if (!box) return false;
    const articles = box.querySelectorAll('article[data-role="user"],article[data-role="assistant"],article[data-role="error"],article.codex-message.human,article.codex-message.codex');
    return articles[articles.length - 1]?.getAttribute('data-role') === 'error';
  };
  const computeMood = (): PyxMood => {
    const working = doc.getElementById('codex-submit')?.dataset.taskState === 'active', t = now();
    if (wasWorking && !working) doneUntil = t + PYX_DONE_MS;
    if (working) doneUntil = 0;
    wasWorking = working;
    let studioOff = false, failed = transcriptFailed();
    try { studioOff = options.studioConnected?.() === false; } catch { studioOff = false; }
    if (!failed && surface() === 'codex') { try { failed = !!options.turnFailed?.(); } catch { failed = false; } }
    alertText = studioOff ? 'Pyx needs you: Studio is not paired' : 'Pyx needs you: the last turn did not finish';
    const typing = doc.activeElement === input && !!input.value.trim();
    return typing ? 'listening' : studioOff || failed ? 'alert' : working ? 'working' : t < doneUntil ? 'done' : 'idle';
  };
  const paint = () => {
    const moving = motion(), still = mood === 'alert' ? 'idle' : mood;
    const frame: 1 | 2 = moving && (mood === 'idle' || mood === 'alert' || mood === 'working') && tick % 2 === 1 ? 2 : 1;
    const key = still + frame; if (key !== shownFrame) { sprite.replaceChildren(spriteFrame(still, frame)); shownFrame = key; }
    const bob = moving && mood === 'done' && tick % 2 === 1 ? 'translateY(-1px)' : '';
    if (body.style.transform !== bob) body.style.transform = bob;
  };
  /** Frame swaps: idle/alert breathe (750 ms + 250 ms), working alternates every 250 ms, done bobs 1px; nothing while reduced or hidden. */
  const animate = () => {
    if (animation !== undefined) { clearTimeout(animation); animation = undefined; }
    if (stopped || mood === 'listening' || !motion()) return;
    const delay = (mood === 'idle' || mood === 'alert') && tick % 2 === 0 ? 750 : 250;
    animation = setTimeout(() => { animation = undefined; tick++; paint(); animate(); }, delay);
  };
  const refresh = () => {
    pending = false; if (stopped) return;
    // The active surface lets CSS hide Codex-only composer notices (#codex-readiness) while Claude or Arcane is shown.
    const shown = surface(); if (form.dataset.surface !== shown) form.dataset.surface = shown;
    placeQueues(); decorateQueues(); decorateChip();
    renderPlaceholder(!!doc.getElementById('codex-messages')?.querySelector('.codex-message'));
    let list: readonly ComposerSubagent[] = [];
    try { list = surface() === 'codex' ? [] : (options.subagents?.() ?? []).slice(0, 12); } catch { list = []; }
    renderAgents(list);
    let reported: ComposerContextWindow | null = null;
    try { reported = options.contextWindow?.() ?? null; } catch { reported = null; }
    renderContext(reported);
    const next = computeMood();
    if (next !== mood) { pyx.classList.remove('pyx--' + mood); pyx.classList.add('pyx--' + next); pyx.dataset.mood = next; mood = next; tick = 0; }
    const text = mood === 'alert' ? alertText : PYX_STATUS[mood]; if (status.textContent !== text) status.textContent = text;
    if (doneTimer !== undefined) { clearTimeout(doneTimer); doneTimer = undefined; }
    if (mood === 'done') doneTimer = setTimeout(() => { doneTimer = undefined; schedule(); }, Math.max(0, doneUntil - now()) + 20);
    paint(); animate();
  };
  const schedule = () => {
    if (pending || stopped) return; pending = true;
    if (typeof win?.requestAnimationFrame === 'function') win.requestAnimationFrame(() => refresh()); else setTimeout(refresh, 16);
  };
  const observer = typeof win?.MutationObserver === 'function' ? new win.MutationObserver(() => { placeQueues(); schedule(); }) : null;
  const observed = new WeakSet<Node>();
  function observeQueue(node: Node): void { if (observer && !observed.has(node)) { observed.add(node); observer.observe(node, { childList: true, subtree: true }); } }
  const attach = () => {
    if (observer) {
      observer.observe(form, { childList: true });
      const trigger = doc.getElementById('codex-model-trigger'); if (trigger) observer.observe(trigger, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
      const box = doc.getElementById('codex-messages'); if (box) observer.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-role', 'data-tool-state'] });
      const submit = doc.getElementById('codex-submit'); if (submit) observer.observe(submit, { attributes: true, attributeFilter: ['data-task-state'] });
      observer.observe(input, { attributes: true, attributeFilter: ['placeholder', 'data-steer-hint'] });
      for (const strip of Array.from(doc.querySelectorAll('.queue-strip'))) { observed.delete(strip); observeQueue(strip); }
    }
    const listen = (target: EventTarget | null | undefined, type: string, handler: EventListener) => { if (!target) return; target.addEventListener(type, handler); removers.push(() => target.removeEventListener(type, handler)); };
    for (const type of ['input', 'focus', 'blur']) listen(input, type, schedule);
    listen(doc, 'visibilitychange', schedule); listen(pyx, 'click', openPyx);
    try { const query = win?.matchMedia?.('(prefers-reduced-motion: no-preference)'); if (query && typeof query.addEventListener === 'function') listen(query, 'change', schedule); } catch { /* Static Pyx. */ }
    for (const subscribe of [options.subscribeSurface, options.subscribeStudio]) { try { const remove = subscribe?.(schedule); if (remove) removers.push(remove); } catch { /* Polled on the next refresh. */ } }
  };
  const detach = () => {
    observer?.disconnect();
    for (const remove of removers.splice(0)) { try { remove(); } catch { /* Already gone. */ } }
    for (const timer of [animation, doneTimer]) if (timer !== undefined) clearTimeout(timer);
    animation = doneTimer = undefined; pending = false;
  };
  attach(); refresh();
  return {
    refresh: schedule,
    mood: () => mood,
    stop() { if (stopped) return; stopped = true; detach(); },
    resume() { if (!stopped) return; stopped = false; attach(); refresh(); },
  };
}
