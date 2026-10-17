/**
 * Plans & credits: the Settings page and the top-bar usage chip.
 *
 * Shows Arcane actions used this month (local, informational, never blocking), monthly plans, quick-buy action packs
 * and Arcane Credits. Every buy button goes through ONE checkout seam on the daemon. Until a billing service is
 * configured and verified the seam answers "not connected" and nothing is charged. Prices and copy come from
 * packages/protocol/src/plans.ts via the daemon; this module never invents a price or a balance.
 */

export interface Offer { id: string; name: string; priceCents: number; blurb: string }
export interface PlanOffer extends Offer { actionsPerMonth: number; features: string[]; highlight?: boolean }
export interface PackOffer extends Offer { actions: number }
export interface CreditOffer extends Offer { credits: number }
export interface UsageSummary {
  month: { key: string; used: number }; today: { key: string; used: number };
  days: { key: string; used: number }[]; conversations: { conversation: string; used: number }[];
  byKind: { 'build-turn': number; 'studio-change': number };
  integrity: 'verified' | 'mismatch' | 'empty';
}
export interface PlansState {
  catalog: {
    placeholderPrices: boolean; currency: string; action: { singular: string; plural: string; definition: string };
    plans: PlanOffer[]; packs: PackOffer[]; credits: { blurb: string; offers: CreditOffer[] };
  };
  billing: { state: 'not-configured' | 'unverified' | 'ready'; origins: string[] };
  gateway: { state: 'disabled' | 'signed-out' | 'ready'; message: string; showInModelPicker: boolean };
  usage: UsageSummary;
}
type Kind = 'plan' | 'pack' | 'credits';

export const PLANS_SECTION_ID = 'settings-plans';
const REFRESH_MS = 30000;
const NOT_CONNECTED_TITLE = "Checkout isn't connected yet";
const NOT_CONNECTED_TEXT = 'Nothing was charged. Connect an Arcane billing service to enable buying. The setup steps are in docs/ARCANE_CREDITS.md.';

const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const str = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length <= max;
const int = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

function offers<T extends Offer>(value: unknown, extra: (row: Record<string, unknown>) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > 6) return null;
  const out: T[] = [];
  for (const raw of value) {
    const row = obj(raw);
    if (!row || !str(row.id, 48) || !ID.test(row.id) || !str(row.name, 32) || !int(row.priceCents) || !str(row.blurb, 120)) return null;
    const parsed = extra(row); if (!parsed) return null; out.push(parsed);
  }
  return out;
}

/** Strict reader for the daemon reply; anything unexpected yields null and the page shows a neutral state. */
export function readPlansState(value: unknown): PlansState | null {
  const root = obj(value), catalog = obj(root?.catalog), action = obj(catalog?.action), credits = obj(catalog?.credits);
  const billing = obj(root?.billing), gateway = obj(root?.gateway), usage = obj(root?.usage);
  if (!catalog || !action || !credits || !billing || !gateway || !usage) return null;
  if (typeof catalog.placeholderPrices !== 'boolean' || !str(catalog.currency, 3) || !/^[A-Z]{3}$/.test(catalog.currency)) return null;
  if (!str(action.singular, 32) || !str(action.plural, 32) || !str(action.definition, 200) || !str(credits.blurb, 200)) return null;
  const base = (row: Record<string, unknown>) => ({ id: row.id as string, name: row.name as string, priceCents: row.priceCents as number, blurb: row.blurb as string });
  const plans = offers<PlanOffer>(catalog.plans, row => int(row.actionsPerMonth) && Array.isArray(row.features) && row.features.length <= 6 && row.features.every(f => str(f, 80))
    ? { ...base(row), actionsPerMonth: row.actionsPerMonth, features: [...row.features as string[]], ...(row.highlight === true ? { highlight: true } : {}) } : null);
  const packs = offers<PackOffer>(catalog.packs, row => int(row.actions) ? { ...base(row), actions: row.actions } : null);
  const creditOffers = offers<CreditOffer>(credits.offers, row => int(row.credits) ? { ...base(row), credits: row.credits } : null);
  if (!plans || !packs || !creditOffers) return null;
  if (!['not-configured', 'unverified', 'ready'].includes(String(billing.state)) || !Array.isArray(billing.origins) || billing.origins.length > 4 || !billing.origins.every(o => str(o, 256) && /^https:\/\/[^/]+$/.test(o))) return null;
  if (!['disabled', 'signed-out', 'ready'].includes(String(gateway.state)) || !str(gateway.message, 200) || typeof gateway.showInModelPicker !== 'boolean') return null;
  const month = obj(usage.month), today = obj(usage.today), kinds = obj(usage.byKind);
  if (!month || !today || !kinds || !str(month.key, 7) || !int(month.used) || !str(today.key, 10) || !int(today.used) || !int(kinds['build-turn']) || !int(kinds['studio-change'])) return null;
  if (!Array.isArray(usage.days) || usage.days.length > 31 || !Array.isArray(usage.conversations) || usage.conversations.length > 8) return null;
  const days: { key: string; used: number }[] = [];
  for (const raw of usage.days) { const d = obj(raw); if (!d || !str(d.key, 10) || !int(d.used)) return null; days.push({ key: d.key, used: d.used }); }
  const conversations: { conversation: string; used: number }[] = [];
  for (const raw of usage.conversations) { const c = obj(raw); if (!c || !str(c.conversation, 160) || !int(c.used)) return null; conversations.push({ conversation: c.conversation, used: c.used }); }
  if (!['verified', 'mismatch', 'empty'].includes(String(usage.integrity))) return null;
  return {
    catalog: { placeholderPrices: catalog.placeholderPrices, currency: catalog.currency, action: { singular: action.singular, plural: action.plural, definition: action.definition },
      plans, packs, credits: { blurb: credits.blurb, offers: creditOffers } },
    billing: { state: billing.state as PlansState['billing']['state'], origins: [...billing.origins as string[]] },
    gateway: { state: gateway.state as PlansState['gateway']['state'], message: gateway.message, showInModelPicker: gateway.showInModelPicker },
    usage: { month: { key: month.key, used: month.used }, today: { key: today.key, used: today.used }, days, conversations,
      byKind: { 'build-turn': kinds['build-turn'], 'studio-change': kinds['studio-change'] }, integrity: usage.integrity as UsageSummary['integrity'] },
  };
}

export function formatPrice(cents: number, currency: string): string {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100); }
  catch { return (cents / 100).toFixed(2) + ' ' + currency; }
}
export const formatCount = (value: number) => new Intl.NumberFormat('en-US').format(value);
export function actionsLabel(count: number, singular = 'action', plural = 'actions'): string { return formatCount(count) + ' ' + (count === 1 ? singular : plural); }
export function chipLabel(state: PlansState): { value: string; unit: string; aria: string } {
  const used = state.usage.month.used, unit = used === 1 ? state.catalog.action.singular : state.catalog.action.plural;
  return { value: formatCount(used), unit, aria: actionsLabel(used, state.catalog.action.singular, state.catalog.action.plural) + ' used this month. Open Plans and credits.' };
}

/** Only an https URL on an origin the daemon verified may leave the app. */
export function checkoutUrlAllowed(url: unknown, origins: readonly string[]): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && origins.includes(parsed.origin); } catch { return false; }
}

interface ClaudeBridge { onEvent(listener: (event: unknown) => void): () => void }
interface BillingBridge { openCheckout(url: string): Promise<unknown> }
export interface PlansOptions {
  token: () => string;
  fetch?: typeof fetch;
  desktop?: { claudeChat?: ClaudeBridge; billing?: BillingBridge; runtime?: string } | null;
  open?: (url: string) => void;
}

export function startPlans(doc: Document, options: PlansOptions) {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const view = doc.defaultView;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T | null;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  let current: PlansState | null = null, pending = false, timer: number | null = null;
  const headers = (json = false): Record<string, string> => ({ Authorization: 'Bearer ' + options.token(), ...(json ? { 'Content-Type': 'application/json' } : {}) });

  function notice(kind: 'info' | 'error' | 'ready', title: string, text: string): void {
    const box = el('plans-notice'); if (!box) return;
    box.replaceChildren(make('strong', 'plans-notice-title', title), make('span', 'plans-notice-text', text));
    box.dataset.kind = kind; box.hidden = false;
    try { box.scrollIntoView({ block: 'nearest' }); } catch { /* Older engines: the live region still announces it. */ }
  }

  function offerCard(kind: Kind, offer: PlanOffer | PackOffer | CreditOffer, state: PlansState): HTMLElement {
    const card = make('article', 'plans-offer');
    card.dataset.offerKind = kind; card.dataset.offerId = offer.id;
    if ('highlight' in offer && offer.highlight) card.dataset.highlight = 'true';
    const headingId = 'plans-offer-' + kind + '-' + offer.id;
    const head = make('div', 'plans-offer-head');
    const name = make('h4', 'plans-offer-name', offer.name); name.id = headingId; head.append(name);
    if ('highlight' in offer && offer.highlight) head.append(make('span', 'plans-offer-badge', 'Popular'));
    card.setAttribute('aria-labelledby', headingId);
    const price = make('p', 'plans-offer-price');
    price.append(make('span', 'plans-offer-amount', formatPrice(offer.priceCents, state.catalog.currency)));
    if (kind === 'plan') price.append(make('span', 'plans-offer-period', '/ month'));
    const amount = kind === 'plan' ? actionsLabel((offer as PlanOffer).actionsPerMonth, state.catalog.action.singular, state.catalog.action.plural) + ' a month'
      : kind === 'pack' ? actionsLabel((offer as PackOffer).actions, state.catalog.action.singular, state.catalog.action.plural)
      : formatCount((offer as CreditOffer).credits) + ' credits';
    card.append(head, price, make('p', 'plans-offer-amount-line', amount), make('p', 'plans-offer-blurb', offer.blurb));
    if (kind === 'plan') {
      const list = make('ul', 'plans-offer-features');
      for (const feature of (offer as PlanOffer).features) list.append(make('li', undefined, feature));
      card.append(list);
    }
    const button = make('button', kind === 'plan' && 'highlight' in offer && offer.highlight ? 'plans-buy plans-buy-primary' : 'plans-buy',
      kind === 'plan' ? 'Choose ' + offer.name : kind === 'pack' ? 'Buy pack' : 'Add credits');
    button.type = 'button'; button.setAttribute('aria-describedby', headingId);
    button.addEventListener('click', () => { void checkout(kind, offer.id, button); });
    card.append(button);
    return card;
  }

  function renderUsage(state: PlansState): void {
    const { usage, catalog } = state;
    const month = el('plans-usage-month'); if (month) month.textContent = formatCount(usage.month.used);
    const unit = el('plans-usage-unit'); if (unit) unit.textContent = (usage.month.used === 1 ? catalog.action.singular : catalog.action.plural) + ' used this month';
    const detail = el('plans-usage-detail');
    if (detail) detail.textContent = actionsLabel(usage.today.used, catalog.action.singular, catalog.action.plural) + ' today · ' +
      formatCount(usage.byKind['build-turn']) + ' build turns · ' + formatCount(usage.byKind['studio-change']) + ' Studio changes';
    const definition = el('plans-usage-definition'); if (definition) definition.textContent = catalog.action.definition;
    const bars = el('plans-usage-days');
    if (bars) {
      const max = Math.max(1, ...usage.days.map(day => day.used));
      bars.replaceChildren(...usage.days.map(day => {
        const item = make('li', 'plans-day');
        const bar = make('span', 'plans-day-bar'); bar.style.setProperty('--plans-day', String(Math.round((day.used / max) * 100)));
        if (day.used === 0) bar.dataset.empty = 'true';
        item.append(bar, make('span', 'sr-only', day.key + ': ' + actionsLabel(day.used, catalog.action.singular, catalog.action.plural)));
        item.title = day.key + ': ' + formatCount(day.used);
        return item;
      }));
    }
    const integrity = el('plans-usage-integrity');
    if (integrity) { integrity.hidden = usage.integrity !== 'mismatch'; integrity.textContent = 'The local usage log changed outside Arcane. Counts may be incomplete.'; }
  }

  function render(state: PlansState): void {
    const chip = el<HTMLButtonElement>('arcane-balance-chip');
    if (chip) {
      const label = chipLabel(state);
      const value = el('arcane-balance-chip-value'), unit = el('arcane-balance-chip-unit');
      if (value) value.textContent = label.value; if (unit) unit.textContent = label.unit;
      chip.setAttribute('aria-label', label.aria); chip.title = 'Arcane actions used this month'; chip.hidden = false;
    }
    renderUsage(state);
    const placeholder = el('plans-placeholder'); if (placeholder) placeholder.hidden = !state.catalog.placeholderPrices;
    const billing = el('plans-billing-state');
    if (billing) {
      billing.textContent = state.billing.state === 'ready' ? 'Checkout connected' : state.billing.state === 'unverified' ? 'Checkout unreachable' : 'Checkout not connected';
      billing.className = 'status-text ' + (state.billing.state === 'ready' ? 'ok' : 'neutral');
    }
    const plans = el('plans-list'); if (plans) plans.replaceChildren(...state.catalog.plans.map(plan => offerCard('plan', plan, state)));
    const packs = el('plans-packs'); if (packs) packs.replaceChildren(...state.catalog.packs.map(pack => offerCard('pack', pack, state)));
    const credits = el('plans-credits'); if (credits) credits.replaceChildren(...state.catalog.credits.offers.map(offer => offerCard('credits', offer, state)));
    const creditsBlurb = el('plans-credits-blurb'); if (creditsBlurb) creditsBlurb.textContent = state.catalog.credits.blurb;
    const gateway = el('plans-gateway-state');
    if (gateway) { gateway.textContent = state.gateway.message; gateway.dataset.state = state.gateway.state; }
  }

  async function refresh(): Promise<void> {
    if (pending || !options.token()) return;
    pending = true;
    try {
      const response = await doFetch('/v1/plans/state', { headers: headers(), cache: 'no-store' });
      if (!response.ok) return;
      const state = readPlansState(await response.json());
      if (state) { current = state; render(state); }
    } catch { /* Usage is informational; keep the last good view. */ }
    finally { pending = false; }
  }

  async function checkout(kind: Kind, id: string, button: HTMLButtonElement): Promise<void> {
    if (button.disabled) return;
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    try {
      const response = await doFetch('/v1/plans/checkout', { method: 'POST', headers: headers(true), body: JSON.stringify({ kind, id }) });
      const reply = obj(response.ok ? await response.json() : null);
      if (reply?.state === 'ready' && current && checkoutUrlAllowed(reply.url, current.billing.origins)) {
        const url = reply.url as string;
        if (options.desktop?.billing?.openCheckout) { await options.desktop.billing.openCheckout(url); notice('ready', 'Checkout opened in your browser', 'Finish there. Your balance updates after the billing service confirms payment.'); }
        else if (options.desktop?.runtime !== 'desktop' && options.open) { options.open(url); notice('ready', 'Checkout opened in a new tab', 'Finish there. Your balance updates after the billing service confirms payment.'); }
        else notice('info', 'Checkout can’t open here yet', 'This build has no safe way to open the checkout page. Nothing was charged.');
      } else if (reply?.state === 'unknown-offer') notice('error', 'That offer is unavailable', 'Refresh Plans & credits and try again. Nothing was charged.');
      else notice('info', NOT_CONNECTED_TITLE, NOT_CONNECTED_TEXT);
    } catch { notice('info', NOT_CONNECTED_TITLE, NOT_CONNECTED_TEXT); }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  }

  const reportClaudeTurn = (value: unknown) => {
    const event = obj(value);
    if (!event || event.type !== 'done' || event.ok !== true || typeof event.turnId !== 'string') return;
    const conversationId = typeof event.conversationId === 'string' ? event.conversationId : null;
    void doFetch('/v1/actions/record', { method: 'POST', headers: headers(true), body: JSON.stringify({ source: 'claude', turnId: event.turnId, conversationId }) })
      .then(() => refresh()).catch(() => {});
  };
  let unsubscribe: (() => void) | null = null;

  const openSection = () => {
    const EventType = view?.CustomEvent;
    if (EventType) doc.dispatchEvent(new EventType('workspace:settingsrequest', { detail: { target: PLANS_SECTION_ID } }));
    void refresh();
  };
  // DOM listeners attach once; stop/resume only own the timer and the Claude bridge subscription.
  el('arcane-balance-chip')?.addEventListener('click', openSection);
  for (const control of Array.from(doc.querySelectorAll<HTMLElement>('[data-settings-section-target="' + PLANS_SECTION_ID + '"]'))) control.addEventListener('click', () => { void refresh(); });
  el('plans-refresh')?.addEventListener('click', () => { void refresh(); });

  function stop(): void { if (timer !== null) view?.clearInterval(timer); timer = null; unsubscribe?.(); unsubscribe = null; }
  function resume(): void {
    stop();
    try { unsubscribe = options.desktop?.claudeChat?.onEvent(reportClaudeTurn) ?? null; } catch { unsubscribe = null; }
    if (view) timer = view.setInterval(() => { if (doc.visibilityState !== 'hidden') void refresh(); }, REFRESH_MS);
    void refresh();
  }
  resume();
  return { refresh, state: () => current, stop, resume };
}
