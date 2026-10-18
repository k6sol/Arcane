/**
 * Payment processor calls over plain HTTPS (no SDK): Checkout Session creation and webhook signature verification.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CatalogOffer, GatewayConfig } from './config.ts';

export class SignatureError extends Error {}

/**
 * Verifies a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=...]`): HMAC-SHA256 over `<t>.<raw body>` with the
 * endpoint secret, constant-time compared, and the timestamp must be within `toleranceSeconds` of now (replay window).
 */
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, secret: string, toleranceSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): void {
  if (!secret) throw new SignatureError('Webhook secret is not configured.');
  if (typeof header !== 'string' || header.length > 2048) throw new SignatureError('Missing signature.');
  let timestamp = NaN; const signatures: string[] = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('='); if (index < 1) continue;
    const key = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || !signatures.length) throw new SignatureError('Malformed signature.');
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) throw new SignatureError('Signature timestamp outside the tolerance window.');
  const expected = createHmac('sha256', secret).update(String(timestamp) + '.').update(rawBody).digest();
  if (!signatures.some(signature => timingSafeEqual(Buffer.from(signature, 'hex'), expected))) throw new SignatureError('Signature mismatch.');
}

/** Test helper and documentation of the scheme: produces a header the verifier accepts. */
export function signWebhookPayload(rawBody: string | Buffer, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return 't=' + timestamp + ',v1=' + createHmac('sha256', secret).update(String(timestamp) + '.').update(rawBody).digest('hex');
}

export interface CheckoutSessionResult { id: string; url: string }

/** Customer selection is server-owned; browsers cannot name another customer's billing portal. */
export async function createCustomerPortalSession(config: GatewayConfig, customerId: string | null, doFetch: typeof fetch = globalThis.fetch): Promise<{url:string}> {
  if(!customerId||!/^cus_[A-Za-z0-9]+$/.test(customerId))throw new Error('No billing customer is available.');
  if(!config.stripe.secretKey)throw new Error('Billing is not configured.');
  const response=await doFetch(config.stripe.apiBase+'/v1/billing_portal/sessions',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:'Bearer '+config.stripe.secretKey,'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({customer:customerId,return_url:config.publicOrigin+'/account'}).toString()});
  const text=await response.text();if(!response.ok||Buffer.byteLength(text)>65536)throw new Error('Billing portal is unavailable.');
  const value=JSON.parse(text) as Record<string,unknown>,url=new URL(String(value.url));
  if(url.protocol!=='https:'||url.hostname!=='billing.stripe.com'||url.port||url.username||url.password)throw new Error('Billing portal response could not be verified.');
  return {url:url.href};
}

/** Creates a hosted Checkout Session for one catalog offer. Prices come only from the server-side catalog. */
export async function createCheckoutSession(config: GatewayConfig, offer: CatalogOffer, account: { id: string; email: string; customer_id: string | null },
  idempotencyKey: string, doFetch: typeof fetch = globalThis.fetch): Promise<CheckoutSessionResult> {
  if (!config.stripe.secretKey) throw new Error('Checkout is not configured.');
  if (!offer.price) throw new Error('This offer has no price configured.');
  const form = new URLSearchParams();
  const subscription = offer.kind === 'plan';
  form.set('mode', subscription ? 'subscription' : 'payment');
  form.set('line_items[0][price]', offer.price);
  form.set('line_items[0][quantity]', '1');
  form.set('success_url', config.stripe.successUrl + '?session_id={CHECKOUT_SESSION_ID}');
  form.set('cancel_url', config.stripe.cancelUrl);
  form.set('client_reference_id', account.id);
  if (account.customer_id) form.set('customer', account.customer_id); else form.set('customer_email', account.email);
  for (const [key, value] of [['account_id', account.id], ['offer_id', offer.id], ['kind', offer.kind]]) {
    form.set('metadata[' + key + ']', value);
    form.set((subscription ? 'subscription_data' : 'payment_intent_data') + '[metadata][' + key + ']', value);
  }
  const response = await doFetch(config.stripe.apiBase + '/v1/checkout/sessions', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + config.stripe.secretKey, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey },
    body: form.toString(),
  });
  const text = (await response.text()).slice(0, 65536);
  if (!response.ok) throw new Error('Checkout session request failed (' + response.status + ').');
  const value = JSON.parse(text) as Record<string, unknown>;
  if (typeof value.id !== 'string' || !/^cs_[A-Za-z0-9_]{1,128}$/.test(value.id) || typeof value.url !== 'string') throw new Error('Checkout session reply was not understood.');
  const checkout=new URL(value.url);
  if(checkout.protocol!=='https:'||checkout.hostname!=='checkout.stripe.com'||checkout.port||checkout.username||checkout.password)throw new Error('Checkout destination could not be verified.');
  return { id: value.id, url: value.url };
}
