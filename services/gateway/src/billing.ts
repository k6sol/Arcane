/**
 * Grants from verified payment webhooks, plus balance and usage reads.
 *
 * Idempotency is layered: each webhook event id is recorded once (`webhook_events`), and each grant has its own key
 * (`checkout:<session>` / `invoice:<invoice>`) so a re-sent event under a new id still grants at most once. The event
 * record and the grant commit in the same transaction.
 */
import type { DatabaseSync } from 'node:sqlite';
import { findOffer, type CatalogOffer, type GatewayConfig } from './config.ts';
import { audit, getAccount, tx, type Account, type Row } from './db.ts';
import { periodKey } from './metering.ts';

export type WebhookOutcome = 'granted' | 'duplicate' | 'ignored' | 'updated';

const obj = (value: unknown): Record<string, any> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_]{1,255}$/.test(value) ? value : null;
const monthLater = (now: number) => { const date = new Date(now); date.setUTCMonth(date.getUTCMonth() + 1); return date.toISOString(); };

function grant(db: DatabaseSync, account: Account, offer: CatalogOffer, key: string, now: number, extra: { subscriptionId?: string | null; customerId?: string | null; renewsAt?: string }): boolean {
  if (db.prepare('SELECT 1 FROM grants WHERE key = ?').get(key)) return false;
  const credits = offer.kind === 'credits' ? offer.credits : 0;
  const actions = offer.kind === 'pack' ? offer.actions : offer.kind === 'plan' ? offer.actionsPerMonth : 0;
  db.prepare('INSERT INTO grants (key, account_id, offer_id, credits, actions, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(key, account.id, offer.id, credits, actions, now);
  if (offer.kind === 'credits') db.prepare('UPDATE accounts SET credits = credits + ? WHERE id = ?').run(credits, account.id);
  else if (offer.kind === 'pack') db.prepare('UPDATE accounts SET pack_actions = pack_actions + ? WHERE id = ?').run(actions, account.id);
  else db.prepare('UPDATE accounts SET plan_id = ?, plan_actions = ?, renews_at = ?, subscription_id = COALESCE(?, subscription_id) WHERE id = ?')
    .run(offer.id, actions, extra.renewsAt ?? monthLater(now), extra.subscriptionId ?? null, account.id);
  if (extra.customerId) db.prepare('UPDATE accounts SET customer_id = COALESCE(customer_id, ?) WHERE id = ?').run(extra.customerId, account.id);
  audit(db, account.id, 'billing.grant', { key, offer: offer.id, credits, actions });
  return true;
}

function checkoutCompleted(db: DatabaseSync, config: GatewayConfig, session: Record<string, any>, now: number): WebhookOutcome {
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) return 'ignored';
  const sessionId = id(session.id), metadata = obj(session.metadata) ?? {};
  const accountId = id(session.client_reference_id) ?? id(metadata.account_id);
  if (!sessionId || !accountId || (metadata.account_id && metadata.account_id !== accountId)) return 'ignored';
  const offer = findOffer(config, metadata.offer_id);
  const account = getAccount(db, accountId);
  if (!offer || !account || (offer.kind === 'plan') !== (session.mode === 'subscription')) { audit(db, accountId, 'billing.unmatched_session', { session: sessionId }); return 'ignored'; }
  return grant(db, account, offer, 'checkout:' + sessionId, now, { subscriptionId: id(session.subscription), customerId: id(session.customer) }) ? 'granted' : 'duplicate';
}

function invoicePaid(db: DatabaseSync, config: GatewayConfig, invoice: Record<string, any>, now: number): WebhookOutcome {
  // The first period is granted by checkout.session.completed; only renewals reset the allowance here.
  if (invoice.billing_reason !== 'subscription_cycle') return 'ignored';
  const details = obj(invoice.parent?.subscription_details), line = obj(invoice.lines?.data?.[0]);
  const subscriptionId = id(invoice.subscription) ?? id(details?.subscription);
  const invoiceId = id(invoice.id);
  if (!subscriptionId || !invoiceId) return 'ignored';
  const account = db.prepare('SELECT * FROM accounts WHERE subscription_id = ?').get(subscriptionId) as unknown as Account | undefined;
  const offer = findOffer(config, details?.metadata?.offer_id ?? line?.metadata?.offer_id ?? account?.plan_id);
  if (!account || !offer || offer.kind !== 'plan') { audit(db, account?.id ?? null, 'billing.unmatched_invoice', { invoice: invoiceId }); return 'ignored'; }
  const end = Number(line?.period?.end);
  const renewsAt = Number.isSafeInteger(end) && end > 0 ? new Date(end * 1000).toISOString() : monthLater(now);
  return grant(db, account, offer, 'invoice:' + invoiceId, now, { renewsAt }) ? 'granted' : 'duplicate';
}

function subscriptionEnded(db: DatabaseSync, subscription: Record<string, any>): WebhookOutcome {
  const subscriptionId = id(subscription.id);
  const account = subscriptionId ? db.prepare('SELECT * FROM accounts WHERE subscription_id = ?').get(subscriptionId) as unknown as Account | undefined : undefined;
  if (!account) return 'ignored';
  db.prepare('UPDATE accounts SET plan_id = NULL, plan_actions = 0, renews_at = NULL, subscription_id = NULL WHERE id = ?').run(account.id);
  audit(db, account.id, 'billing.plan_ended', {});
  return 'updated';
}

/** Applies one signature-verified event exactly once. */
export function applyWebhookEvent(db: DatabaseSync, config: GatewayConfig, event: unknown, now = Date.now()): WebhookOutcome {
  const value = obj(event), eventId = id(value?.id), type = typeof value?.type === 'string' ? value.type.slice(0, 80) : null;
  const object = obj(value?.data?.object);
  if (!value || !eventId || !type || !object) throw new Error('Malformed event.');
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM webhook_events WHERE id = ?').get(eventId)) return 'duplicate';
    db.prepare('INSERT INTO webhook_events (id, type, received_at) VALUES (?, ?, ?)').run(eventId, type, now);
    switch (type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': return checkoutCompleted(db, config, object, now);
      case 'invoice.paid': return invoicePaid(db, config, object, now);
      case 'customer.subscription.deleted': return subscriptionEnded(db, object);
      default: return 'ignored';
    }
  });
}

export function balanceOf(account: Account) {
  const actions = account.plan_actions + account.pack_actions;
  return {
    credits: account.credits,
    actionsRemaining: account.plan_id || actions > 0 ? actions : null,
    plan: account.plan_id ? account.plan_id.slice(0, 1).toUpperCase() + account.plan_id.slice(1) : null,
    renewsAt: account.renews_at,
  };
}

export function usageOf(db: DatabaseSync, accountId: string, now = new Date()) {
  const period = periodKey(now);
  const row = db.prepare('SELECT COALESCE(SUM(credits), 0) AS credits, COALESCE(SUM(actions), 0) AS actions FROM usage WHERE account_id = ? AND period = ?').get(accountId, period) as Row;
  return { period, creditsUsed: Number(row.credits), actionsUsed: Number(row.actions) };
}
