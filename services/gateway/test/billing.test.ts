import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signWebhookPayload, verifyWebhookSignature, SignatureError, createCheckoutSession, createCustomerPortalSession } from '../src/stripe.ts';
import { testConfig } from './helpers.ts';
import { bearer, formPost, postJson, signIn, startHarness, WEBHOOK_SECRET, type Harness } from './helpers.ts';

const accountId = (h: Harness, email = 'maker@example.com') => (h.db.prepare('SELECT id FROM accounts WHERE email = ?').get(email) as { id: string }).id;
function deliver(h: Harness, event: unknown, options: { secret?: string; at?: number } = {}) {
  const raw = JSON.stringify(event);
  return fetch(h.base + '/v1/stripe/webhook', { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signWebhookPayload(raw, options.secret ?? WEBHOOK_SECRET, options.at ?? Math.floor(h.clock.now / 1000)) } });
}
const completed = (eventId: string, session: Record<string, unknown>) => ({ id: eventId, type: 'checkout.session.completed', data: { object: { payment_status: 'paid', mode: 'payment', ...session } } });

test('payment destinations must be the exact hosted processor origins', async () => {
  const config = testConfig(), offer = config.catalog.find(value => value.id === 'pro')!;
  for (const url of ['https://checkout.stripe.com.evil.example/pay', 'https://evil.example/pay', 'http://checkout.stripe.com/pay', 'https://user@checkout.stripe.com/pay']) {
    const reply = (async () => Response.json({ id: 'cs_test_fixture', url })) as typeof fetch;
    await assert.rejects(createCheckoutSession(config, offer, { id: 'acct_fixture', email: 'member@example.com', customer_id: null }, 'fixture-key', reply), /destination/);
  }
  const forgedPortal = (async () => Response.json({ url: 'https://billing.stripe.com.evil.example/session' })) as typeof fetch;
  await assert.rejects(createCustomerPortalSession(config, 'cus_Fixture', forgedPortal), /could not be verified/);
});

test('checkout creates a processor session from the server-side price map (mocked processor)', async () => {
  const h = await startHarness();
  try {
    const token = await signIn(h);
    const reply = await postJson(h.base + '/v1/checkout', { offer: 'credits-10' }, { ...bearer(token), 'Idempotency-Key': 'buy-credits-0001' });
    assert.equal(reply.status, 200);
    const body = await reply.json() as Record<string, string>;
    assert.equal(body.id, 'cs_test_1'); assert.match(body.url, /^https:\/\/checkout\.stripe\.com\//);
    const call = h.stripeCalls[0];
    assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(call.headers.Authorization, 'Bearer sk_test_reference0000');
    assert.match(call.headers['Idempotency-Key'], /^arcane-[0-9a-f]{48}$/);
    assert.equal(call.body.get('mode'), 'payment');
    assert.equal(call.body.get('line_items[0][price]'), 'price_credits10_test');
    assert.equal(call.body.get('client_reference_id'), accountId(h));
    assert.equal(call.body.get('metadata[offer_id]'), 'credits-10');
    assert.equal(call.body.get('customer_email'), 'maker@example.com');

    // Same idempotency key: same session, no second processor call.
    const again = await (await postJson(h.base + '/v1/checkout', { offer: 'credits-10' }, { ...bearer(token), 'Idempotency-Key': 'buy-credits-0001' })).json();
    assert.deepEqual(again, body); assert.equal(h.stripeCalls.length, 1);

    // Plans are subscriptions; unknown or unpriced offers are refused; auth is required for JSON.
    await postJson(h.base + '/v1/checkout', { offer: 'pro' }, bearer(token));
    assert.equal(h.stripeCalls[1].body.get('mode'), 'subscription');
    assert.equal(h.stripeCalls[1].body.get('subscription_data[metadata][account_id]'), accountId(h));
    assert.equal((await postJson(h.base + '/v1/checkout', { offer: 'nope' }, bearer(token))).status, 404);
    assert.equal((await postJson(h.base + '/v1/checkout', { offer: 'studio' }, bearer(token))).status, 503, 'no price configured');
    assert.equal((await postJson(h.base + '/v1/checkout', { offer: 'pro' })).status, 401);

    // Browser flow from the desktop: GET /checkout page, form POST, 303 redirect to the hosted session.
    const pageHtml = await (await fetch(h.base + '/checkout?kind=pack&offer=pack-100')).text();
    assert.ok(pageHtml.includes('name="offer" value="pack-100"'));
    assert.equal((await fetch(h.base + '/checkout?kind=plan&offer=pack-100')).status, 404);
    const redirect = await fetch(h.base + '/v1/checkout', formPost({ offer: 'pack-100', email: 'new@example.com' }));
    assert.equal(redirect.status, 303);
    assert.match(redirect.headers.get('location') ?? '', /^https:\/\/checkout\.stripe\.com\//);
    assert.equal(h.stripeCalls.at(-1)!.body.get('client_reference_id'), accountId(h, 'new@example.com'));
  } finally { await h.close(); }
});

test('webhook signatures are verified with a replay window', () => {
  const raw = Buffer.from('{"id":"evt_1"}'), now = 1_800_000_000;
  const header = signWebhookPayload(raw, 'secret_one', now);
  verifyWebhookSignature(raw, header, 'secret_one', 300, now + 299);
  assert.throws(() => verifyWebhookSignature(raw, header, 'secret_two', 300, now), SignatureError);
  assert.throws(() => verifyWebhookSignature(raw, header, 'secret_one', 300, now + 301), SignatureError);
  assert.throws(() => verifyWebhookSignature(Buffer.from('{"id":"evt_2"}'), header, 'secret_one', 300, now), SignatureError);
  assert.throws(() => verifyWebhookSignature(raw, undefined, 'secret_one', 300, now), SignatureError);
  assert.throws(() => verifyWebhookSignature(raw, 't=' + now, 'secret_one', 300, now), SignatureError);
  // Multiple v1 signatures (secret rotation): any match passes.
  verifyWebhookSignature(raw, header + ',v1=' + '0'.repeat(64), 'secret_one', 300, now);
});

test('verified webhooks grant credits, packs and plans exactly once; balance and usage read back', async () => {
  const h = await startHarness();
  try {
    const token = await signIn(h);
    const id = accountId(h);
    const balance = async () => (await fetch(h.base + '/v1/balance', { headers: bearer(token) })).json();
    assert.deepEqual(await balance(), { credits: 0, actionsRemaining: null, plan: null, renewsAt: null });

    // Bad signature and stale timestamp are rejected and nothing is granted.
    const credits = completed('evt_credits_1', { id: 'cs_test_a', client_reference_id: id, metadata: { account_id: id, offer_id: 'credits-10' } });
    assert.equal((await deliver(h, credits, { secret: 'whsec_wrong_secret_value' })).status, 400);
    assert.equal((await deliver(h, credits, { at: Math.floor(h.clock.now / 1000) - 3600 })).status, 400);
    assert.equal((await balance() as any).credits, 0);

    assert.deepEqual(await (await deliver(h, credits)).json(), { received: true, outcome: 'granted' });
    assert.deepEqual(await (await deliver(h, credits)).json(), { received: true, outcome: 'duplicate' }, 'same event replayed');
    const resent = { ...credits, id: 'evt_credits_2' };
    assert.deepEqual(await (await deliver(h, resent)).json(), { received: true, outcome: 'duplicate' }, 'same session under a new event id');
    assert.equal((await balance() as any).credits, 1000);

    // Unpaid sessions and tampered offers do not grant.
    assert.equal((await (await deliver(h, completed('evt_unpaid', { id: 'cs_test_b', payment_status: 'unpaid', client_reference_id: id, metadata: { offer_id: 'credits-10' } }))).json() as any).outcome, 'ignored');
    assert.equal((await (await deliver(h, completed('evt_bad_offer', { id: 'cs_test_c', client_reference_id: id, metadata: { offer_id: 'credits-999' } }))).json() as any).outcome, 'ignored');
    assert.equal((await (await deliver(h, completed('evt_mode', { id: 'cs_test_d', client_reference_id: id, metadata: { offer_id: 'pro' } }))).json() as any).outcome, 'ignored', 'a plan must be a subscription');

    await deliver(h, completed('evt_pack', { id: 'cs_test_e', client_reference_id: id, metadata: { offer_id: 'pack-100' } }));
    await deliver(h, completed('evt_plan', { id: 'cs_test_f', mode: 'subscription', subscription: 'sub_123', customer: 'cus_123', client_reference_id: id, metadata: { offer_id: 'pro' } }));
    let value = await balance() as any;
    assert.equal(value.credits, 1000); assert.equal(value.actionsRemaining, 1300); assert.equal(value.plan, 'Pro');
    assert.ok(!Number.isNaN(Date.parse(value.renewsAt)));

    // Renewal resets the plan allowance (pack actions are kept) and moves renewsAt to the period end.
    h.db.prepare('UPDATE accounts SET plan_actions = 7 WHERE id = ?').run(id);
    const renewal = { id: 'evt_inv_1', type: 'invoice.paid', data: { object: { id: 'in_1', billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription: 'sub_123', metadata: { offer_id: 'pro' } } }, lines: { data: [{ period: { end: 1_800_000_000 } }] } } } };
    assert.equal((await (await deliver(h, renewal)).json() as any).outcome, 'granted');
    assert.equal((await (await deliver(h, { ...renewal, id: 'evt_inv_1b' })).json() as any).outcome, 'duplicate');
    value = await balance();
    assert.equal(value.actionsRemaining, 1300); assert.equal(value.renewsAt, new Date(1_800_000_000 * 1000).toISOString());
    // The first invoice is covered by checkout.session.completed.
    assert.equal((await (await deliver(h, { ...renewal, id: 'evt_inv_0', data: { object: { ...renewal.data.object, id: 'in_0', billing_reason: 'subscription_create' } } })).json() as any).outcome, 'ignored');

    await deliver(h, { id: 'evt_sub_del', type: 'customer.subscription.deleted', data: { object: { id: 'sub_123' } } });
    value = await balance();
    assert.equal(value.plan, null); assert.equal(value.actionsRemaining, 100);
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM grants WHERE account_id = ?").get(id) as any).n, 4);
    assert.deepEqual(await (await fetch(h.base + '/v1/usage', { headers: bearer(token) })).json(), { period: '2026-10', creditsUsed: 0, actionsUsed: 0 });
  } finally { await h.close(); }
});
