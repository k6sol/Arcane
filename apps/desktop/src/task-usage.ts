import type { NativeTokenUsage, Snapshot, ThreadState, TokenUsageBreakdown, TokenUsageReport } from '../../../packages/codex-client/src/types.js';

// Pure projection: no DOM, network, storage, credentials, native operations or wall clock.
const MAX_COUNT = 1_000_000_000_000, MAX_TASKS = 128;
const KEYS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const;
const ACTIVE = new Set(['starting', 'inProgress', 'cancelling']);
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
export interface TaskUsageScope { projectId: string; connectionId: string; threadId: string; turnId: string }
export type TaskUsageSnapshot = Pick<Snapshot, 'connectionId' | 'connected' | 'thread' | 'account' | 'events' | 'lastEventSeq' | 'droppedEvents' | 'operations' | 'usage'>;
export interface ReadonlyTaskUsageState {
  /** Exact host project ID (or exact projectPath if that is the existing host identity). */
  readonly projectId: string;
  readonly snapshot: Readonly<TaskUsageSnapshot> | null;
  /** Set only by the live human turn-start hook, never on restoration/resume. */
  readonly liveTurnId?: string;
}
export interface TaskUsageRateCard {
  readonly authorized: true;
  readonly scope: Readonly<TaskUsageScope>;
  readonly model: string;
  readonly currency: string;
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cachedInputPerMillion?: number;
  readonly cacheWriteInputPerMillion?: number;
  /** Explicit provider/rate configuration assertion for older protocols. */
  readonly missingCacheWrite?: 'not-applicable';
  readonly provenance: { readonly id: string; readonly asOf: string };
}
export interface TaskUsageCost {
  kind: 'included' | 'estimate' | 'unavailable'; label: string;
  estimate: { amount: number; currency: string; label: string } | null;
}
export interface TaskUsageView {
  scope: TaskUsageScope | null; status: ThreadState['turnStatus']; active: boolean;
  current: TokenUsageBreakdown | null; cumulative: TokenUsageBreakdown | null;
  lastRequest: TokenUsageBreakdown | null; modelContextWindow: number | null;
  elapsedMs: number | null; elapsedKind: 'elapsed' | 'observed' | 'reported' | 'unavailable';
  reportedDurationMs: number | null;
  cost: TaskUsageCost;
  footer: { visible: boolean; text: string; accessibleLabel: string; detail: string };
}
interface TaskRecord {
  scope: TaskUsageScope; model: string; status: ThreadState['turnStatus'];
  baseline: TokenUsageBreakdown | null; current: TokenUsageBreakdown | null;
  cumulative: TokenUsageBreakdown | null; lastRequest: TokenUsageBreakdown | null; context: number | null;
  elapsed: number | null; since: number | null; partial: boolean; sealed: boolean; uncertain: boolean;
  usageSeq: number; pausedAtSeq: number | null; reportedDurationMs: number | null;
  subscription: boolean;
  modelReliable: boolean;
  missedStart: boolean;
}
interface Ledger { seq: number; dropped: number; tasks: Map<string, TaskRecord>; latest: TaskRecord | null; fresh: boolean }
const count = (v: unknown, max = MAX_COUNT): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f]/.test(v);
function data(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) &&
    Reflect.ownKeys(v).length <= 32 && Reflect.ownKeys(v).every(k => typeof k === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'));
}
function counts(v: unknown): TokenUsageBreakdown | null {
  if (!data(v) || KEYS.some(k => !Object.hasOwn(v, k) || !count(v[k])) || v.cacheWriteInputTokens !== undefined && !count(v.cacheWriteInputTokens)) return null;
  const result = Object.fromEntries(KEYS.map(k => [k, v[k]])) as unknown as TokenUsageBreakdown;
  if (v.cacheWriteInputTokens !== undefined) result.cacheWriteInputTokens = v.cacheWriteInputTokens as number;
  return result.totalTokens >= result.inputTokens + result.outputTokens && result.cachedInputTokens + (result.cacheWriteInputTokens ?? 0) <= result.inputTokens &&
    result.reasoningOutputTokens <= result.outputTokens ? result : null;
}
/** Revalidates optional telemetry at the browser boundary; strips all unrecognised fields. */
export function readTaskUsage(value: unknown): NativeTokenUsage | null {
  if (!data(value) || !['source', 'continuity', 'total', 'last', 'modelContextWindow'].every(k => Object.hasOwn(value, k)) ||
      value.source !== 'thread/tokenUsage/updated' || !['reported', 'uncertain'].includes(String(value.continuity))) return null;
  const total = counts(value.total), last = counts(value.last);
  if (!total || !last || KEYS.some(k => last[k] > total[k]) ||
      total.cacheWriteInputTokens !== undefined && last.cacheWriteInputTokens !== undefined && last.cacheWriteInputTokens > total.cacheWriteInputTokens ||
      !(value.modelContextWindow === null || count(value.modelContextWindow, 1_000_000_000))) return null;
  return { source: 'thread/tokenUsage/updated', total, last, modelContextWindow: value.modelContextWindow as number | null, continuity: value.continuity as NativeTokenUsage['continuity'] };
}
const sameScope = (a: TaskUsageScope, b: TaskUsageScope) => a.projectId === b.projectId && a.connectionId === b.connectionId && a.threadId === b.threadId && a.turnId === b.turnId;
const key = (s: Omit<TaskUsageScope, 'turnId'>) => JSON.stringify([s.projectId, s.connectionId, s.threadId]);
function subtract(total: TokenUsageBreakdown, baseline: TokenUsageBreakdown): TokenUsageBreakdown | null {
  if (KEYS.some(k => total[k] < baseline[k])) return null;
  const value: Record<string, number> = Object.fromEntries(KEYS.map(k => [k, total[k] - baseline[k]]));
  if (total.cacheWriteInputTokens !== undefined && baseline.cacheWriteInputTokens !== undefined) {
    if (total.cacheWriteInputTokens < baseline.cacheWriteInputTokens) return null;
    value.cacheWriteInputTokens = total.cacheWriteInputTokens - baseline.cacheWriteInputTokens;
  }
  return counts(value);
}
function zeroBaseline(): TokenUsageBreakdown {
  return { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
}
function settle(task: TaskRecord, now: number, partial = false): void {
  if (task.since !== null) { task.elapsed = (task.elapsed ?? 0) + Math.max(0, now - task.since); task.since = null; }
  task.partial ||= partial;
}
function money(amount: number, currency: string): string {
  // Do not round a small positive estimate to a misleading zero charge.
  return amount > 0 && amount < 0.0001 ? `<0.0001 ${currency}` : `${amount.toFixed(4)} ${currency}`;
}
export function taskUsageCost(scope: TaskUsageScope, model: string, current: TokenUsageBreakdown | null, subscription: boolean, card?: TaskUsageRateCard): TaskUsageCost {
  let estimate: TaskUsageCost['estimate'] = null;
  if (current && counts(current) && data(card) && card.authorized === true && data(card.scope) && sameScope(scope, card.scope as unknown as TaskUsageScope) && card.model === model &&
      typeof card.currency === 'string' && /^[A-Z]{3}$/.test(card.currency) && data(card.provenance) && identifier(card.provenance.id) &&
      typeof card.provenance.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(card.provenance.asOf)) {
    const rate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000;
    const cached = current.cachedInputTokens, write = current.cacheWriteInputTokens;
    if (rate(card.inputPerMillion) && rate(card.outputPerMillion) &&
        (!cached || rate(card.cachedInputPerMillion)) &&
        (write !== undefined ? !write || rate(card.cacheWriteInputPerMillion) : card.missingCacheWrite === 'not-applicable')) {
      const amount = ((current.inputTokens - cached - (write ?? 0)) * card.inputPerMillion + cached * (card.cachedInputPerMillion ?? 0) +
        (write ?? 0) * (card.cacheWriteInputPerMillion ?? 0) + current.outputTokens * card.outputPerMillion) / 1_000_000;
      if (Number.isFinite(amount) && amount <= 1_000_000_000) estimate = { amount, currency: card.currency, label: `Estimate ${money(amount, card.currency)} (API equivalent)` };
    }
  }
  return subscription ? { kind: 'included', label: 'Included in plan', estimate } : estimate ?
    { kind: 'estimate', label: estimate.label, estimate } : { kind: 'unavailable', label: 'Estimate unavailable', estimate: null };
}
// ---- Maintained price table and cost display (estimates only; never a bill) ----
/** Published standard API list prices in USD per million tokens. Exact model IDs only: an unknown model shows tokens only. */
export interface UsagePrice { readonly inputPerMillion: number; readonly cachedInputPerMillion: number | null; readonly outputPerMillion: number }
export const USAGE_PRICES_AS_OF = '2026-10-06';
export const USAGE_PRICE_TABLE_ID = 'arcane-price-table';
const price = (inputPerMillion: number, cachedInputPerMillion: number | null, outputPerMillion: number): UsagePrice => Object.freeze({ inputPerMillion, cachedInputPerMillion, outputPerMillion });
const USAGE_PRICES: Readonly<Record<string, UsagePrice>> = Object.freeze(Object.assign(Object.create(null) as Record<string, UsagePrice>, {
  // ChatGPT models.
  'gpt-5': price(1.25, 0.125, 10), 'gpt-5-codex': price(1.25, 0.125, 10), 'gpt-5-mini': price(0.25, 0.025, 2), 'gpt-5-nano': price(0.05, 0.005, 0.4),
  'gpt-5.1': price(1.25, 0.125, 10), 'gpt-5.1-codex': price(1.25, 0.125, 10), 'gpt-5.1-codex-max': price(1.25, 0.125, 10), 'gpt-5.1-codex-mini': price(0.25, 0.025, 2),
  'gpt-5.2': price(1.75, 0.175, 14), 'gpt-4.1': price(2, 0.5, 8), 'gpt-4.1-mini': price(0.4, 0.1, 1.6), 'gpt-4o': price(2.5, 1.25, 10), 'gpt-4o-mini': price(0.15, 0.075, 0.6),
  'o3': price(2, 0.5, 8), 'o4-mini': price(1.1, 0.275, 4.4),
  // Claude models (the Claude engine reports cache tokens inside input, so only the base input rate applies).
  'claude-fable-5-1': price(10, null, 50), 'claude-fable-5': price(10, null, 50), 'claude-opus-5-5': price(4, null, 20), 'claude-opus-5': price(5, null, 25),
  'claude-opus-4-8': price(5, null, 25), 'claude-opus-4-7': price(5, null, 25), 'claude-opus-4-6': price(5, null, 25),
  'claude-sonnet-5-5': price(2, null, 10), 'claude-sonnet-5': price(2, null, 10), 'claude-sonnet-4-6': price(3, null, 15),
  'claude-haiku-5-5': price(0.1, null, 0.5), 'claude-haiku-4-5': price(1, null, 5),
}));
/** The maintained price for an exact model ID (a trailing release date or context suffix is ignored); null when unknown. */
export function usagePrice(model: unknown): UsagePrice | null {
  if (typeof model !== 'string' || model.length > 128) return null;
  const id = model.trim().toLowerCase().replace(/\[1m\]$/, '');
  return USAGE_PRICES[id] ?? USAGE_PRICES[id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '')] ?? null;
}
/** USD estimate from the price table. Cached input uses the cached rate when the table has one. */
export function estimateUsageUsd(model: unknown, tokens: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }): number | null {
  const rates = usagePrice(model), ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT;
  if (!rates || !ok(tokens.inputTokens) || !ok(tokens.outputTokens)) return null;
  const cached = rates.cachedInputPerMillion !== null && ok(tokens.cachedInputTokens) ? Math.min(tokens.cachedInputTokens, tokens.inputTokens) : 0;
  const amount = ((tokens.inputTokens - cached) * rates.inputPerMillion + cached * (rates.cachedInputPerMillion ?? 0) + tokens.outputTokens * rates.outputPerMillion) / 1_000_000;
  return Number.isFinite(amount) ? amount : null;
}
/** A rate card for the exact task from the maintained table, or undefined for an unknown model. */
export function tableRateCard(scope: TaskUsageScope, model: string): TaskUsageRateCard | undefined {
  const rates = usagePrice(model);
  if (!rates || rates.cachedInputPerMillion === null) return undefined;
  return { authorized: true, scope: { ...scope }, model, currency: 'USD', inputPerMillion: rates.inputPerMillion, outputPerMillion: rates.outputPerMillion,
    cachedInputPerMillion: rates.cachedInputPerMillion, cacheWriteInputPerMillion: rates.inputPerMillion, missingCacheWrite: 'not-applicable',
    provenance: { id: USAGE_PRICE_TABLE_ID, asOf: USAGE_PRICES_AS_OF } };
}
/** Viewer's cost display choice. `rate` converts USD to `currency`; without it costs stay in USD. */
export interface CostDisplayPreferences { show: boolean; currency: string; rate: number | null }
export const COST_CURRENCIES = Object.freeze(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'HKD', 'SGD', 'KRW', 'INR', 'BRL', 'MXN', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'ZAR', 'TRY', 'ILS', 'AED'] as const);
const EURO = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' ');
const REGION_CURRENCY: Readonly<Record<string, string>> = Object.freeze({ US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', CN: 'CNY', HK: 'HKD', SG: 'SGD', KR: 'KRW',
  IN: 'INR', BR: 'BRL', MX: 'MXN', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', ZA: 'ZAR', TR: 'TRY', IL: 'ILS', AE: 'AED', ...Object.fromEntries(EURO.map(r => [r, 'EUR'])) });
/** A usable BCP 47 locale, or en-US. */
export function costLocale(value: unknown): string {
  try { return typeof value === 'string' && value.length <= 64 && Intl.NumberFormat.supportedLocalesOf([value]).length ? value : 'en-US'; } catch { return 'en-US'; }
}
/** The locale's usual currency when Arcane lists it; USD otherwise. */
export function currencyForLocale(locale: string): string {
  let region: string | undefined;
  try { region = new Intl.Locale(costLocale(locale)).maximize().region; } catch { region = undefined; }
  return (region && REGION_CURRENCY[region]) ?? 'USD';
}
export const DEFAULT_COST_PREFERENCES: Readonly<CostDisplayPreferences> = Object.freeze({ show: true, currency: 'USD', rate: null });
/** Validates a stored preference row; anything unexpected falls back to the defaults (show on, locale currency, no rate). */
export function readCostPreferences(value: unknown, fallbackCurrency = 'USD'): CostDisplayPreferences {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const listed = (v: unknown): v is string => typeof v === 'string' && (COST_CURRENCIES as readonly string[]).includes(v);
  const currency = listed(row.currency) ? row.currency : listed(fallbackCurrency) ? fallbackCurrency : 'USD';
  const rate = typeof row.rate === 'number' && Number.isFinite(row.rate) && row.rate > 0 && row.rate <= 1_000_000 && currency !== 'USD' ? row.rate : null;
  return { show: row.show !== false, currency, rate };
}
/** '~$0.31' (or the converted local currency when a rate is set). Tiny amounts keep two significant digits instead of rounding to zero. */
export function formatUsageCost(usd: number, preferences: CostDisplayPreferences = DEFAULT_COST_PREFERENCES, locale = 'en-US'): string {
  const converted = preferences.currency !== 'USD' && preferences.rate !== null;
  const currency = converted ? preferences.currency : 'USD', amount = Math.max(0, usd) * (converted ? preferences.rate! : 1);
  const options: Intl.NumberFormatOptions = amount > 0 && amount < 0.01 ? { maximumSignificantDigits: 2 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  try { return '~' + new Intl.NumberFormat(costLocale(locale), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', ...options }).format(amount); }
  catch { return '~' + amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2) + ' ' + currency; }
}
/** Compact token count: 950, 12.3k, 1.2M. */
export function compactTokenCount(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1e6) return (value / 1000).toFixed(value < 1e5 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (value / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}
/** Cost display context for the footer: preferences plus the formatting locale. */
export interface TaskUsageCostDisplay { preferences: CostDisplayPreferences; locale: string }
function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}h ${minutes}m ${seconds % 60}s` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
export function taskUsageFooter(view: Omit<TaskUsageView, 'footer'>, display?: TaskUsageCostDisplay): TaskUsageView['footer'] {
  const reliable = view.current !== null || view.cumulative !== null || view.elapsedMs !== null;
  const visible = view.active || reliable;
  if (!visible) return { visible: false, text: '', accessibleLabel: '', detail: '' };
  // With a display context the estimate reads 'Tokens 12,400 (~$0.31)'; without one, the original labels remain.
  const estimate = view.cost.estimate, money = display && estimate && estimate.currency === 'USD' && display.preferences.show
    ? formatUsageCost(estimate.amount, display.preferences, display.locale) : null;
  const parts = [view.current ? `Tokens ${view.current.totalTokens.toLocaleString('en-US')}${money ? ` (${money})` : ''}` : view.lastRequest ?
    `Last reported tokens ${view.lastRequest.totalTokens.toLocaleString('en-US')} (request)` : view.active ? 'Tokens pending' : 'Task tokens unavailable'];
  if (view.cost.kind === 'included') parts.push(view.cost.label);
  else if (view.cost.kind === 'estimate' && !display) parts.push(view.cost.label);
  if (view.cost.kind === 'included' && estimate && !display) parts.push(estimate.label);
  parts.push(view.elapsedMs === null ? 'Elapsed unavailable' : `${view.elapsedKind === 'observed' ? 'Observed elapsed' : view.elapsedKind === 'reported' ? 'Reported elapsed' : 'Elapsed'} ${duration(view.elapsedMs)}`);
  if (view.status === 'unknown') parts.push('Task state unknown');
  const c = view.current;
  const details = [c ? `Task input ${c.inputTokens}; cached input ${c.cachedInputTokens}; output ${c.outputTokens}; reasoning output ${c.reasoningOutputTokens}${c.cacheWriteInputTokens === undefined ? '' : `; cache write input ${c.cacheWriteInputTokens}`}.` : 'Task totals require a reliable baseline.'];
  if (view.cumulative) details.push(`Thread total ${view.cumulative.totalTokens}.`);
  if (view.lastRequest) details.push(`Last reported request ${view.lastRequest.totalTokens} tokens.`);
  if (view.modelContextWindow !== null) details.push(`Reported model context window ${view.modelContextWindow} tokens.`);
  if (money && display) {
    const converted = display.preferences.currency !== 'USD' && display.preferences.rate !== null;
    details.push(`${money} is an ${view.cost.kind === 'included' ? 'estimated API-equivalent cost; your plan is not charged per token' : 'estimated API cost'}` +
      ` (Arcane price table, ${USAGE_PRICES_AS_OF}${converted ? `; converted at your rate of ${display.preferences.rate} ${display.preferences.currency} per USD` : ''}).`);
  }
  const detail = details.join(' ');
  return { visible, text: parts.join(' · '), accessibleLabel: `Task usage. ${parts.join('. ')}. ${detail}`, detail };
}
/** Instance owned by one chat controller. All retention is bounded and scoped to exact identities. */
export class TaskUsageTracker {
  #ledgers = new Map<string, Ledger>();
  #selected: TaskRecord | null = null;
  #lastNow = 0;
  #clockStarted = false;
  constructor(private readonly monotonicNow: () => number = () => performance.now()) {}
  #now(): number {
    const now = this.monotonicNow();
    if (Number.isFinite(now) && now >= this.#lastNow && now <= Number.MAX_SAFE_INTEGER) { this.#lastNow = now; this.#clockStarted = true; }
    return this.#lastNow;
  }
  #task(ledger: Ledger, scope: TaskUsageScope, model: string): TaskRecord {
    const existing = ledger.tasks.get(scope.turnId);
    if (existing) return existing;
    const previous = ledger.latest;
    const baseline = previous && TERMINAL.has(previous.status) && !previous.uncertain ? previous.cumulative :
      ledger.fresh && !previous ? zeroBaseline() : null;
    const task: TaskRecord = { scope, model, status: 'unknown', baseline: baseline ? { ...baseline } : null,
      current: null, cumulative: null, lastRequest: null, context: null, elapsed: null, since: null,
      partial: true, sealed: false, uncertain: false, usageSeq: 0, pausedAtSeq: null, reportedDurationMs: null, subscription: false, modelReliable: true, missedStart: false };
    ledger.tasks.set(scope.turnId, task); ledger.latest = task;
    while (ledger.tasks.size > MAX_TASKS) ledger.tasks.delete(ledger.tasks.keys().next().value!);
    return task;
  }
  #usage(task: TaskRecord, raw: unknown, seq: number): void {
    if (seq <= task.usageSeq) return;
    const usage = readTaskUsage(raw);
    if (!usage) return;
    task.usageSeq = seq;
    if (usage.continuity === 'uncertain' || task.cumulative && !subtract(usage.total, task.cumulative)) task.uncertain = true;
    if (task.uncertain) { task.current = null; task.cumulative = null; task.lastRequest = null; task.baseline = null; return; }
    task.current = task.baseline ? subtract(usage.total, task.baseline) : null;
    if (task.baseline && !task.current) { task.uncertain = true; task.baseline = null; task.cumulative = null; task.lastRequest = null; return; }
    task.cumulative = { ...usage.total }; task.lastRequest = { ...usage.last }; task.context = usage.modelContextWindow;
  }
  /** Presentation context for the footer's cost estimate (set by the footer UI). */
  costDisplay: TaskUsageCostDisplay | undefined;
  read(state: ReadonlyTaskUsageState, card?: TaskUsageRateCard): TaskUsageView {
    const now = this.#now(), snapshot = state.snapshot;
    const empty = (): TaskUsageView => {
      if (this.#selected) settle(this.#selected, now, true);
      this.#selected = null;
      const view = { scope: null, status: 'unknown' as const, active: false, current: null, cumulative: null, lastRequest: null,
        modelContextWindow: null, elapsedMs: null, elapsedKind: 'unavailable' as const, reportedDurationMs: null,
        cost: { kind: 'unavailable' as const, label: 'Estimate unavailable', estimate: null } };
      return { ...view, footer: taskUsageFooter(view, this.costDisplay) };
    };
    if (!identifier(state.projectId) || !snapshot || !identifier(snapshot.connectionId) || !snapshot.thread || !identifier(snapshot.thread.threadId) ||
        !count(snapshot.lastEventSeq, Number.MAX_SAFE_INTEGER) || !count(snapshot.droppedEvents, Number.MAX_SAFE_INTEGER) ||
        !Array.isArray(snapshot.events) || snapshot.events.length > 256 || !Array.isArray(snapshot.operations) || snapshot.operations.length > 128) return empty();
    const thread = snapshot.thread, ledgerKey = key({ projectId: state.projectId, connectionId: snapshot.connectionId, threadId: thread.threadId });
    let ledger = this.#ledgers.get(ledgerKey);
    if (!ledger) {
      const fresh = snapshot.operations.some(o => o.method === 'thread/start' && o.state === 'acknowledged' && o.threadId === thread.threadId) &&
        !snapshot.operations.some(o => o.method === 'thread/resume') && snapshot.droppedEvents === 0 &&
        (snapshot.events[0]?.seq === 1 || snapshot.operations.filter(o => o.method === 'turn/start').length <= 1);
      ledger = { seq: 0, dropped: 0, tasks: new Map(), latest: null, fresh };
      this.#ledgers.set(ledgerKey, ledger);
      while (this.#ledgers.size > MAX_TASKS) this.#ledgers.delete(this.#ledgers.keys().next().value!);
    }
    // An older snapshot must not change tokens, status, subscription evidence or the clock.
    if (snapshot.lastEventSeq < ledger.seq) {
      const selected = this.#selected && key(this.#selected.scope) === ledgerKey ? this.#selected : null;
      return this.#view(selected, selected?.since !== null && selected !== null, now, selected?.subscription ?? false, card);
    }
    // Native turn IDs are unique. A known prior ID cannot become the current task again,
    // even when a delayed host snapshot happens to carry the same event high-water mark.
    if (thread.turnId && ledger.tasks.has(thread.turnId) && ledger.latest && ledger.latest.scope.turnId !== thread.turnId) {
      const latest = this.#selected && key(this.#selected.scope) === ledgerKey ? this.#selected : ledger.latest;
      return this.#view(latest, latest.since !== null, now, latest.subscription, card);
    }
    let previousSeq = 0;
    for (const event of snapshot.events) {
      if (!data(event) || !count(event.seq, Number.MAX_SAFE_INTEGER) || event.seq === 0 || event.seq <= previousSeq || event.seq > snapshot.lastEventSeq) return empty();
      previousSeq = event.seq;
    }
    const newEvents = snapshot.events.filter(e => e.seq > ledger!.seq);
    const gap = snapshot.droppedEvents > ledger.dropped || newEvents.length > 0 && newEvents[0]!.seq > ledger.seq + 1 ||
      newEvents.some((e, i) => i > 0 && e.seq !== newEvents[i - 1]!.seq + 1) || snapshot.lastEventSeq > (newEvents.at(-1)?.seq ?? ledger.seq);
    if (gap) { ledger.fresh = false; for (const task of ledger.tasks.values()) { task.baseline = null; task.current = null; } }
    for (const event of newEvents) {
      if (!('threadId' in event) || event.threadId !== thread.threadId || !('turnId' in event) || !identifier(event.turnId)) continue;
      if (event.type !== 'turn' && event.type !== 'usage') continue;
      if (event.turnId !== thread.turnId && !ledger.tasks.has(event.turnId) && !snapshot.operations.some(o =>
        o.method === 'turn/start' && o.threadId === thread.threadId && o.turnId === event.turnId && ['pending', 'acknowledged'].includes(o.state))) continue;
      const task = this.#task(ledger, { projectId: state.projectId, connectionId: snapshot.connectionId, threadId: thread.threadId, turnId: event.turnId }, thread.selection.model);
      if (event.type === 'usage') this.#usage(task, event.usage, event.seq);
      else if (TERMINAL.has(event.status)) {
        task.status = event.status as ThreadState['turnStatus']; task.sealed = true; settle(task, now);
        if (count(event.durationMs, 31_536_000_000)) task.reportedDurationMs = event.durationMs;
      } else if (event.status === 'inProgress' && !task.sealed && (task.pausedAtSeq === null || event.seq > task.pausedAtSeq)) task.pausedAtSeq = null;
    }
    ledger.seq = snapshot.lastEventSeq; ledger.dropped = snapshot.droppedEvents;
    if (!identifier(thread.turnId)) {
      if (!snapshot.connected || thread.turnStatus !== 'starting') return empty();
      if (this.#selected) settle(this.#selected, now, true);
      this.#selected = null;
      const view: Omit<TaskUsageView, 'footer'> = { scope: null, status: 'starting', active: true, current: null, cumulative: null, lastRequest: null,
        modelContextWindow: null, elapsedMs: null, elapsedKind: 'unavailable', reportedDurationMs: null,
        cost: snapshot.account?.auth === 'subscription' ? { kind: 'included', label: 'Included in plan', estimate: null } : { kind: 'unavailable', label: 'Estimate unavailable', estimate: null } };
      return { ...view, footer: taskUsageFooter(view, this.costDisplay) };
    }
    const task = this.#task(ledger, { projectId: state.projectId, connectionId: snapshot.connectionId, threadId: thread.threadId, turnId: thread.turnId }, thread.selection.model);
    const report = snapshot.usage as TokenUsageReport | undefined;
    if (report && data(report) && report.threadId === thread.threadId && report.turnId === thread.turnId && count(report.seq, Number.MAX_SAFE_INTEGER) &&
        report.seq > 0 && report.seq <= snapshot.lastEventSeq) this.#usage(task, report, report.seq);
    if (this.#selected && this.#selected !== task) settle(this.#selected, now, true);
    this.#selected = task;
    task.subscription = snapshot.account?.auth === 'subscription';
    if (!task.sealed && task.model !== thread.selection.model) task.modelReliable = false;
    const active = snapshot.connected && ACTIVE.has(thread.turnStatus) && !task.sealed && task.pausedAtSeq === null;
    if (active) {
      task.status = thread.turnStatus;
      if (!this.#clockStarted) task.missedStart = true;
      if (task.since === null && this.#clockStarted) {
        const firstObservation = task.elapsed === null;
        task.since = now; task.elapsed ??= 0;
        task.partial = firstObservation ? task.missedStart || state.liveTurnId !== task.scope.turnId : true;
      }
    } else {
      settle(task, now, !TERMINAL.has(thread.turnStatus));
      if (!task.sealed && (!snapshot.connected || thread.turnStatus === 'unknown')) task.pausedAtSeq = ledger.seq;
      if (!task.sealed && (task.pausedAtSeq === null || !ACTIVE.has(thread.turnStatus))) task.status = snapshot.connected ? thread.turnStatus : 'unknown';
      if (TERMINAL.has(task.status)) task.sealed = true;
    }
    if (TERMINAL.has(task.status) && count(thread.durationMs, 31_536_000_000)) task.reportedDurationMs = thread.durationMs;
    return this.#view(task, active, now, snapshot.account?.auth === 'subscription', card);
  }
  #view(task: TaskRecord | null, active: boolean, now: number, subscription: boolean, card?: TaskUsageRateCard): TaskUsageView {
    const current = task?.uncertain ? null : task?.current ?? null;
    const localElapsed = task?.elapsed === null || !task ? null : task.elapsed + (task.since === null ? 0 : Math.max(0, now - task.since));
    const reported = task?.reportedDurationMs ?? null;
    const useReported = reported !== null && (localElapsed === null || task?.partial);
    const elapsedMs = useReported ? reported : localElapsed;
    const view: Omit<TaskUsageView, 'footer'> = { scope: task ? { ...task.scope } : null, status: task?.status ?? 'unknown', active,
      current: current ? { ...current } : null, cumulative: task?.cumulative ? { ...task.cumulative } : null,
      lastRequest: task?.lastRequest ? { ...task.lastRequest } : null, modelContextWindow: task?.context ?? null,
      elapsedMs, elapsedKind: elapsedMs === null ? 'unavailable' : useReported ? 'reported' : task?.partial ? 'observed' : 'elapsed', reportedDurationMs: reported,
      cost: task ? taskUsageCost(task.scope, task.model, task.modelReliable ? current : null, subscription, card ?? tableRateCard(task.scope, task.model)) : { kind: 'unavailable', label: 'Estimate unavailable', estimate: null } };
    return { ...view, footer: taskUsageFooter(view, this.costDisplay) };
  }
  /** Stop when the bridge is explicitly cleared or disposed. No background elapsed is invented. */
  clear(): void { if (this.#selected) settle(this.#selected, this.#now(), true); this.#selected = null; }
}

/** Subscription bridge shape for the chat worker; the parent owns binding and disposal. */
export type SubscribeReadonlyTaskState = (listener: (state: ReadonlyTaskUsageState) => void) => () => void;
