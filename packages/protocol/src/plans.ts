/**
 * Arcane plans, action packs and Arcane Credits: the ONE place prices, allowances and copy live.
 *
 * EDIT HERE. Every price below is a PLACEHOLDER. Nothing in Arcane charges money, grants purchased balance
 * or calls a paid model gateway from these values. They only describe what the Settings page shows.
 *
 * - Prices are integer minor units (cents) so rounding never changes what a buyer sees.
 * - `billing.serviceUrl` stays empty until you run a hosted Arcane billing service (see docs/ARCANE_CREDITS.md).
 *   While it is empty every buy button shows "Checkout isn't connected yet".
 * - `gateway.url` stays empty until you run a hosted Arcane model gateway. While it is empty the Arcane provider
 *   is disabled and hidden from the model picker.
 * - Only https origins listed in `allowedOrigins` are ever opened or called.
 */

export interface PlanOffer {
  id: string; name: string; priceCents: number; actionsPerMonth: number; blurb: string; features: string[]; highlight?: boolean;
}
export interface PackOffer { id: string; name: string; priceCents: number; actions: number; blurb: string }
export interface CreditOffer { id: string; name: string; priceCents: number; credits: number; blurb: string }
export interface PlansConfig {
  version: 1;
  /** Set to false once every price below is a real, approved price. The UI labels placeholder prices. */
  placeholderPrices: boolean;
  currency: string;
  action: { singular: string; plural: string; definition: string };
  plans: PlanOffer[];
  packs: PackOffer[];
  credits: { blurb: string; offers: CreditOffer[] };
  billing: {
    /** Hosted Arcane billing service base URL, e.g. 'https://billing.example.com'. Empty = not connected. */
    serviceUrl: string;
    /** Exact https origins Arcane may open for checkout. Must include the serviceUrl origin. */
    allowedOrigins: string[];
  };
  gateway: {
    /** Hosted Arcane model gateway base URL. Empty = Arcane Credits provider disabled and hidden. */
    url: string;
    allowedOrigins: string[];
  };
}

export const ARCANE_PLANS: PlansConfig = {
  version: 1,
  placeholderPrices: true, // PLACEHOLDER: flip to false only after entering real prices.
  currency: 'USD',
  action: {
    singular: 'action', plural: 'actions',
    definition: 'One Arcane action is one finished build turn in chat, or one applied Studio change.',
  },
  plans: [
    { id: 'starter', name: 'Starter', priceCents: 900 /* PLACEHOLDER */, actionsPerMonth: 300 /* PLACEHOLDER */,
      blurb: 'For weekend builds and small games.', features: ['Quick-buy packs anytime', 'Usage history on this device'] },
    { id: 'pro', name: 'Pro', priceCents: 2400 /* PLACEHOLDER */, actionsPerMonth: 1200 /* PLACEHOLDER */, highlight: true,
      blurb: 'For active creators shipping every week.', features: ['Quick-buy packs anytime', 'Usage history by chat', 'Best for weekly releases'] },
    { id: 'studio', name: 'Studio', priceCents: 7900 /* PLACEHOLDER */, actionsPerMonth: 5000 /* PLACEHOLDER */,
      blurb: 'For teams and large worlds.', features: ['Quick-buy packs anytime', 'Usage history by chat', 'Room for large worlds'] },
  ],
  packs: [
    { id: 'pack-100', name: 'Top-up', priceCents: 500 /* PLACEHOLDER */, actions: 100, blurb: 'A quick boost mid-build.' },
    { id: 'pack-500', name: 'Build day', priceCents: 2000 /* PLACEHOLDER */, actions: 500, blurb: 'For a long session.' },
    { id: 'pack-2000', name: 'Launch push', priceCents: 7000 /* PLACEHOLDER */, actions: 2000, blurb: 'For shipping week.' },
  ],
  credits: {
    blurb: 'No ChatGPT or Claude subscription? Arcane Credits let you use the same models through Arcane.',
    offers: [
      { id: 'credits-10', name: '$10 of credits', priceCents: 1000 /* PLACEHOLDER */, credits: 1000 /* PLACEHOLDER */, blurb: 'Try Arcane with no subscription.' },
      { id: 'credits-25', name: '$25 of credits', priceCents: 2500 /* PLACEHOLDER */, credits: 2600 /* PLACEHOLDER */, blurb: 'Includes a small bonus.' },
      { id: 'credits-50', name: '$50 of credits', priceCents: 5000 /* PLACEHOLDER */, credits: 5400 /* PLACEHOLDER */, blurb: 'Best value for regular use.' },
    ],
  },
  billing: { serviceUrl: '' /* SETUP: hosted billing service, see docs/ARCANE_CREDITS.md */, allowedOrigins: [] },
  gateway: { url: '' /* SETUP: hosted model gateway, see docs/ARCANE_CREDITS.md */, allowedOrigins: [] },
};

export type OfferKind = 'plan' | 'pack' | 'credits';
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const COPY = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f<>]/.test(value);
const MONEY = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000_000;
const COUNT = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 100_000_000;

/** Exact https origin, or null. Userinfo, ports other than default, paths, queries and fragments are refused. */
export function httpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.hostname === 'localhost' || /^[0-9.]+$/.test(url.hostname) || url.hostname.includes(':')) return null;
  return url.origin;
}

/** A configured service is an https base URL whose exact origin is allowlisted. Empty means not configured. */
export function serviceBase(service: { url?: string; serviceUrl?: string; allowedOrigins: string[] }): string | null {
  const raw = service.serviceUrl ?? service.url ?? '';
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const origin = httpsOrigin(url.origin);
  if (!origin || url.username || url.password || url.search || url.hash) return null;
  const allowed = new Set(service.allowedOrigins.map(httpsOrigin).filter((entry): entry is string => entry !== null));
  if (!allowed.has(origin)) return null;
  return origin + url.pathname.replace(/\/+$/, '');
}

/** Throws on malformed placeholder edits so a typo can never show a wrong price. */
export function validatePlansConfig(config: PlansConfig): PlansConfig {
  const fail = (what: string): never => { throw new Error('Invalid plans config: ' + what + '. Edit packages/protocol/src/plans.ts.'); };
  if (config.version !== 1) fail('version');
  if (!/^[A-Z]{3}$/.test(config.currency)) fail('currency');
  if (!COPY(config.action.singular, 32) || !COPY(config.action.plural, 32) || !COPY(config.action.definition, 200)) fail('action copy');
  const ids = new Set<string>();
  const unique = (id: string) => { if (!ID.test(id) || ids.has(id)) fail('offer id ' + JSON.stringify(id)); ids.add(id); };
  if (config.plans.length < 1 || config.plans.length > 6) fail('plan count');
  for (const plan of config.plans) {
    unique(plan.id);
    if (!COPY(plan.name, 32) || !COPY(plan.blurb, 120) || !MONEY(plan.priceCents) || !COUNT(plan.actionsPerMonth)) fail('plan ' + plan.id);
    if (plan.features.length > 6 || plan.features.some(feature => !COPY(feature, 80))) fail('plan features ' + plan.id);
  }
  if (config.packs.length > 6) fail('pack count');
  for (const pack of config.packs) { unique(pack.id); if (!COPY(pack.name, 32) || !COPY(pack.blurb, 120) || !MONEY(pack.priceCents) || !COUNT(pack.actions)) fail('pack ' + pack.id); }
  if (!COPY(config.credits.blurb, 200) || config.credits.offers.length > 6) fail('credits');
  for (const offer of config.credits.offers) { unique(offer.id); if (!COPY(offer.name, 32) || !COPY(offer.blurb, 120) || !MONEY(offer.priceCents) || !COUNT(offer.credits)) fail('credits ' + offer.id); }
  for (const service of [config.billing, config.gateway]) {
    if (service.allowedOrigins.length > 8 || service.allowedOrigins.some(origin => httpsOrigin(origin) !== origin)) fail('allowedOrigins must be exact https origins');
  }
  if (config.billing.serviceUrl && !serviceBase(config.billing)) fail('billing.serviceUrl must be https and its origin allowlisted');
  if (config.gateway.url && !serviceBase(config.gateway)) fail('gateway.url must be https and its origin allowlisted');
  return config;
}

export function findOffer(config: PlansConfig, kind: OfferKind, id: string): PlanOffer | PackOffer | CreditOffer | null {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  const list: (PlanOffer | PackOffer | CreditOffer)[] = kind === 'plan' ? config.plans : kind === 'pack' ? config.packs : kind === 'credits' ? config.credits.offers : [];
  return list.find(offer => offer.id === id) ?? null;
}

export type CheckoutResolution =
  | { state: 'not-connected'; message: string }
  | { state: 'unknown-offer'; message: string }
  | { state: 'ready'; url: string };

export const CHECKOUT_NOT_CONNECTED = "Checkout isn't connected yet. Nothing was charged. See docs/ARCANE_CREDITS.md to connect a billing service.";

/**
 * The single checkout seam. The URL is built only from trusted config and a known offer id, never from request text.
 * `verified` is the daemon's latest successful health check of the billing service.
 */
export function resolveCheckout(config: PlansConfig, kind: OfferKind, id: string, verified: boolean): CheckoutResolution {
  const offer = findOffer(config, kind, id);
  if (!offer) return { state: 'unknown-offer', message: 'That offer is not available.' };
  const base = serviceBase(config.billing);
  if (!base || !verified) return { state: 'not-connected', message: CHECKOUT_NOT_CONNECTED };
  const url = new URL(base + '/checkout');
  url.searchParams.set('kind', kind); url.searchParams.set('offer', offer.id);
  if (url.origin !== new URL(base).origin) return { state: 'not-connected', message: CHECKOUT_NOT_CONNECTED };
  return { state: 'ready', url: url.href };
}

/** The public, display-only view of the config sent to the desktop. Service URLs are reduced to a state. */
export function publicCatalog(config: PlansConfig) {
  return {
    placeholderPrices: config.placeholderPrices, currency: config.currency, action: { ...config.action },
    plans: config.plans.map(plan => ({ ...plan, features: [...plan.features] })),
    packs: config.packs.map(pack => ({ ...pack })),
    credits: { blurb: config.credits.blurb, offers: config.credits.offers.map(offer => ({ ...offer })) },
  };
}
export type PublicCatalog = ReturnType<typeof publicCatalog>;
