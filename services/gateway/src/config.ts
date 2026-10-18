/**
 * Gateway configuration. Everything comes from the environment; nothing secret lives in code.
 * `loadConfig(env)` validates once at startup and throws a readable error on a bad value.
 */
import { readFileSync } from 'node:fs';

export type OfferKind = 'plan' | 'pack' | 'credits';
export interface CatalogOffer {
  id: string; kind: OfferKind;
  /** Payment processor price id (server-side only). Offers without one cannot be bought. */
  price: string | null;
  credits: number; actions: number; actionsPerMonth: number;
}
export type ProviderKind = 'anthropic' | 'openai' | 'mock';
export interface ModelEntry {
  id: string; label: string; provider: ProviderKind; upstream: string;
  /** Credits charged per 1,000,000 tokens, before markup. Integers. */
  inputPerMTok: number; outputPerMTok: number;
  maxOutputTokens: number;
}
export interface GatewayConfig {
  production: boolean;
  host: string; port: number; trustProxy: boolean;
  publicUrl: string; publicOrigin: string;
  databaseFile: string;
  authSecret: string;
  corsOrigins: string[];
  stripe: { secretKey: string; webhookSecret: string; apiBase: string; successUrl: string; cancelUrl: string; toleranceSeconds: number };
  providers: { anthropicKey: string; anthropicBase: string; openaiKey: string; openaiBase: string };
  mail: { mode: 'log' | 'webhook' | 'off'; webhookUrl: string; webhookSecret: string; from: string };
  catalog: CatalogOffer[];
  models: ModelEntry[];
  /** Markup in basis points: 10000 = at cost, 12500 = +25 %. */
  markupBps: number;
  /** Credits-equivalent of model usage one plan/pack action covers for one build turn. */
  actionCreditAllowance: number;
  limits: { requestsPerMinute: number; concurrentStreams: number; maxBodyBytes: number; maxJsonBytes: number; maxWebhookBytes: number; streamTimeoutMs: number };
}

/** Default grants mirror packages/protocol/src/plans.ts so the app and the gateway agree. Price ids come from env. */
const DEFAULT_GRANTS: Omit<CatalogOffer, 'price'>[] = [
  { id: 'starter', kind: 'plan', credits: 0, actions: 0, actionsPerMonth: 300 },
  { id: 'pro', kind: 'plan', credits: 0, actions: 0, actionsPerMonth: 1200 },
  { id: 'studio', kind: 'plan', credits: 0, actions: 0, actionsPerMonth: 5000 },
  { id: 'pack-100', kind: 'pack', credits: 0, actions: 100, actionsPerMonth: 0 },
  { id: 'pack-500', kind: 'pack', credits: 0, actions: 500, actionsPerMonth: 0 },
  { id: 'pack-2000', kind: 'pack', credits: 0, actions: 2000, actionsPerMonth: 0 },
  { id: 'credits-10', kind: 'credits', credits: 1000, actions: 0, actionsPerMonth: 0 },
  { id: 'credits-25', kind: 'credits', credits: 2600, actions: 0, actionsPerMonth: 0 },
  { id: 'credits-50', kind: 'credits', credits: 5400, actions: 0, actionsPerMonth: 0 },
];
export const OFFER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,96}$/;
const PRICE_ID = /^[A-Za-z0-9_]{3,128}$/;

export const priceEnvName = (offerId: string) => 'STRIPE_PRICE_' + offerId.toUpperCase().replace(/-/g, '_');

function fail(what: string): never { throw new Error('Invalid gateway config: ' + what + '. See services/gateway/.env.example.'); }
function int(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(name);
  return value;
}
function count(value: unknown, max = 100_000_000): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max; }

function jsonSource(env: Record<string, string | undefined>, inline: string, file: string): unknown {
  if (env[inline]) return JSON.parse(env[inline] as string);
  if (env[file]) return JSON.parse(readFileSync(env[file] as string, 'utf8'));
  return null;
}

function readCatalog(env: Record<string, string | undefined>): CatalogOffer[] {
  const custom = jsonSource(env, 'CATALOG_JSON', 'CATALOG_FILE');
  const rows = custom === null ? DEFAULT_GRANTS.map(row => ({ ...row, price: env[priceEnvName(row.id)] || null })) : custom;
  if (!Array.isArray(rows) || rows.length > 32) fail('CATALOG');
  const ids = new Set<string>();
  return rows.map((row: Record<string, unknown>) => {
    if (!row || typeof row.id !== 'string' || !OFFER_ID.test(row.id) || ids.has(row.id) || !['plan', 'pack', 'credits'].includes(row.kind as string)) fail('catalog offer id/kind');
    ids.add(row.id as string);
    const price = row.price === null || row.price === undefined || row.price === '' ? null : row.price;
    if (price !== null && (typeof price !== 'string' || !PRICE_ID.test(price))) fail('catalog price for ' + row.id);
    const offer: CatalogOffer = { id: row.id as string, kind: row.kind as OfferKind, price: price as string | null,
      credits: (row.credits ?? 0) as number, actions: (row.actions ?? 0) as number, actionsPerMonth: (row.actionsPerMonth ?? 0) as number };
    if (!count(offer.credits) || !count(offer.actions) || !count(offer.actionsPerMonth)) fail('catalog amounts for ' + offer.id);
    if (offer.kind === 'plan' ? offer.actionsPerMonth < 1 : offer.kind === 'pack' ? offer.actions < 1 : offer.credits < 1) fail('catalog grant for ' + offer.id);
    return offer;
  });
}

function readModels(env: Record<string, string | undefined>): ModelEntry[] {
  const rows = jsonSource(env, 'MODELS_JSON', 'MODELS_FILE') ?? [];
  if (!Array.isArray(rows) || rows.length > 32) fail('MODELS');
  const ids = new Set<string>();
  return rows.map((row: Record<string, unknown>) => {
    if (!row || typeof row.id !== 'string' || !MODEL_ID.test(row.id) || ids.has(row.id)) fail('model id');
    ids.add(row.id as string);
    const model: ModelEntry = { id: row.id as string, label: typeof row.label === 'string' ? row.label.slice(0, 64) : row.id as string,
      provider: row.provider as ProviderKind, upstream: row.upstream as string,
      inputPerMTok: row.inputPerMTok as number, outputPerMTok: row.outputPerMTok as number, maxOutputTokens: (row.maxOutputTokens ?? 4096) as number };
    if (!['anthropic', 'openai', 'mock'].includes(model.provider)) fail('model provider for ' + model.id);
    if (model.provider === 'mock' && env.NODE_ENV === 'production') fail('mock models are not allowed in production');
    if (typeof model.upstream !== 'string' || !MODEL_ID.test(model.upstream)) fail('model upstream for ' + model.id);
    if (!count(model.inputPerMTok, 10_000_000) || !count(model.outputPerMTok, 10_000_000) || !count(model.maxOutputTokens, 1_000_000) || model.maxOutputTokens < 1) fail('model prices for ' + model.id);
    return model;
  });
}

function httpsUrl(value: string | undefined, name: string, production: boolean): string {
  if (!value) fail(name + ' is required');
  let url: URL;
  try { url = new URL(value as string); } catch { fail(name); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) fail(name + ' must be https');
  if (url.username || url.password || url.hash) fail(name);
  return url.href.replace(/\/+$/, '');
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const production = env.NODE_ENV === 'production';
  const publicUrl = httpsUrl(env.PUBLIC_URL, 'PUBLIC_URL', production);
  const authSecret = env.AUTH_SECRET ?? '';
  if (authSecret.length < 32) fail('AUTH_SECRET must be at least 32 characters');
  const corsOrigins = (env.CORS_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
  for (const origin of corsOrigins) { let parsed: URL; try { parsed = new URL(origin); } catch { fail('CORS_ORIGINS'); } if (parsed.origin !== origin || parsed.protocol !== 'https:') fail('CORS_ORIGINS must list exact https origins'); }
  const mailMode = (env.MAIL_MODE ?? 'off') as GatewayConfig['mail']['mode'];
  if (!['log', 'webhook', 'off'].includes(mailMode)) fail('MAIL_MODE');
  if (mailMode === 'log' && production) fail('MAIL_MODE=log prints sign-in links and is not allowed in production');
  if (mailMode === 'webhook') httpsUrl(env.MAIL_WEBHOOK_URL, 'MAIL_WEBHOOK_URL', production);
  const stripeKey = env.STRIPE_SECRET_KEY ?? '';
  if (stripeKey && !/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(stripeKey)) fail('STRIPE_SECRET_KEY');
  if (stripeKey && !production && stripeKey.includes('_live_')) fail('live payment keys require NODE_ENV=production');
  const config: GatewayConfig = {
    production,
    host: env.HOST || '0.0.0.0',
    port: int(env, 'PORT', 8787, 1, 65535),
    trustProxy: env.TRUST_PROXY === '1',
    publicUrl, publicOrigin: new URL(publicUrl).origin,
    databaseFile: env.DATABASE_FILE || './data/gateway.sqlite',
    authSecret,
    corsOrigins,
    stripe: {
      secretKey: stripeKey, webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
      apiBase: env.STRIPE_API_BASE ? httpsUrl(env.STRIPE_API_BASE, 'STRIPE_API_BASE', production) : 'https://api.stripe.com',
      successUrl: env.CHECKOUT_SUCCESS_URL ? httpsUrl(env.CHECKOUT_SUCCESS_URL, 'CHECKOUT_SUCCESS_URL', production) : publicUrl + '/checkout/done',
      cancelUrl: env.CHECKOUT_CANCEL_URL ? httpsUrl(env.CHECKOUT_CANCEL_URL, 'CHECKOUT_CANCEL_URL', production) : publicUrl + '/checkout/cancelled',
      toleranceSeconds: int(env, 'STRIPE_WEBHOOK_TOLERANCE_SECONDS', 300, 30, 900),
    },
    providers: {
      anthropicKey: env.ANTHROPIC_API_KEY ?? '', anthropicBase: env.ANTHROPIC_BASE_URL ? httpsUrl(env.ANTHROPIC_BASE_URL, 'ANTHROPIC_BASE_URL', production) : 'https://api.anthropic.com',
      openaiKey: env.OPENAI_API_KEY ?? '', openaiBase: env.OPENAI_BASE_URL ? httpsUrl(env.OPENAI_BASE_URL, 'OPENAI_BASE_URL', production) : 'https://api.openai.com',
    },
    mail: { mode: mailMode, webhookUrl: env.MAIL_WEBHOOK_URL ?? '', webhookSecret: env.MAIL_WEBHOOK_SECRET ?? '', from: env.MAIL_FROM ?? 'Arcane <no-reply@example.invalid>' },
    catalog: readCatalog(env),
    models: readModels(env),
    markupBps: int(env, 'MARKUP_BPS', 12000, 10000, 100000),
    actionCreditAllowance: int(env, 'ACTION_CREDIT_ALLOWANCE', 50, 0, 1_000_000),
    limits: {
      requestsPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', 30, 1, 10000),
      concurrentStreams: int(env, 'MAX_CONCURRENT_STREAMS', 2, 1, 64),
      maxBodyBytes: int(env, 'MAX_CHAT_BODY_BYTES', 1024 * 1024, 1024, 8 * 1024 * 1024),
      maxJsonBytes: 16 * 1024,
      maxWebhookBytes: 512 * 1024,
      streamTimeoutMs: int(env, 'STREAM_TIMEOUT_MS', 300000, 1000, 3600000),
    },
  };
  if (production && (!config.stripe.secretKey || config.stripe.webhookSecret.length < 16)) fail('STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required in production');
  return config;
}

export const findOffer = (config: GatewayConfig, id: unknown): CatalogOffer | null =>
  typeof id === 'string' && OFFER_ID.test(id) ? config.catalog.find(offer => offer.id === id) ?? null : null;
