import {createAccountRoutes} from './account-routes.ts';
/**
 * Arcane gateway HTTP server (node:http, no framework). Routes are documented in docs/ARCANE_CREDITS.md.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { authenticate, confirmLink, describeLink, normalizeEmail, normalizeUserCode, pollToken, requestLink, revoke, startDevice, sweepAuth, type MailSender } from './auth.ts';
import { applyWebhookEvent, balanceOf, usageOf } from './billing.ts';
import { findOffer, OFFER_ID, type GatewayConfig } from './config.ts';
import { accountByEmail, audit, tx, type Account, type Row } from './db.ts';
import { ConcurrencyCap, RateLimiter } from './limits.ts';
import { creditsFor, estimateInputTokens, estimateOutputTokens } from './metering.ts';
import { releaseStaleHolds, reserve, settle } from './metering-store.ts';
import type { ChatMessage, UpstreamStreamer } from './providers.ts';
import { createCheckoutSession, SignatureError, verifyWebhookSignature } from './stripe.ts';

export interface GatewayDeps {
  config: GatewayConfig; db: DatabaseSync; upstream: UpstreamStreamer; sendMail: MailSender;
  /** Fetch used for payment processor calls (injected in tests). */
  fetch?: typeof fetch;
  accountFetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const html = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function createGateway(deps: GatewayDeps) {
  const { config, db } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (line => console.log(line));
  const accountRate = new RateLimiter(config.limits.requestsPerMinute);
  const ipRate = new RateLimiter(20);
  const streams = new ConcurrencyCap(config.limits.concurrentStreams);
  const released = releaseStaleHolds(db);
  if (released) log('Released ' + released + ' stale credit holds from an earlier run.');

  function baseHeaders(res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify(body));
  }
  function page(res: ServerResponse, status: number, title: string, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'" });
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + html(title) +
      '</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1d1b24;background:#faf9fc}' +
      'input,button{font:inherit;padding:.6rem .8rem;width:100%;box-sizing:border-box;margin:.3rem 0;border-radius:8px;border:1px solid #c9c4d6}' +
      'button{background:#5b3fd1;color:#fff;border:0;cursor:pointer}code{font-size:1.4rem;letter-spacing:.1em}' +
      '@media (prefers-color-scheme:dark){body{background:#15131b;color:#ece9f5}input{background:#221f2b;color:inherit;border-color:#3a3548}}</style></head><body><h1>' +
      html(title) + '</h1>' + body + '</body></html>');
  }
  async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) throw new HttpError(413, 'body_too_large', 'Request body too large.');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) throw new HttpError(413, 'body_too_large', 'Request body too large.');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
  async function readJson(req: IncomingMessage, max = config.limits.maxJsonBytes): Promise<Record<string, unknown>> {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'unsupported_media_type', 'Send application/json.');
    let value: unknown;
    try { value = JSON.parse((await readBody(req, max)).toString('utf8')); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'bad_json', 'Malformed JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'bad_json', 'Expected a JSON object.');
    return value as Record<string, unknown>;
  }
  async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'unsupported_media_type', 'Send a form.');
    return new URLSearchParams((await readBody(req, config.limits.maxJsonBytes)).toString('utf8'));
  }
  /** Browser form posts must come from this gateway's own pages (CSRF). */
  function sameOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== config.publicOrigin) throw new HttpError(403, 'cross_origin', 'Cross-site form posts are refused.');
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'] as string)) throw new HttpError(403, 'cross_origin', 'Cross-site form posts are refused.');
  }
  function clientIp(req: IncomingMessage): string {
    const forwarded = config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return forwarded || req.socket.remoteAddress || 'unknown';
  }
  function ipLimit(req: IncomingMessage): void { if (!ipRate.take('ip:' + clientIp(req), now())) throw new HttpError(429, 'rate_limited', 'Too many requests. Try again in a minute.'); }
  function requireAccount(req: IncomingMessage): Account {
    const account = authenticate(db, config, req.headers.authorization, now());
    if (!account) throw new HttpError(401, 'unauthorized', 'Sign in to your Arcane account.');
    return account;
  }
  function cors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST'); res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    return false;
  }

  // ---- checkout --------------------------------------------------------------------------------------------------
  async function startCheckout(account: Account, offerId: unknown, idempotencyKey: string | null): Promise<{ status: number; body: { id: string; url: string } | { error: string; message: string } }> {
    const offer = findOffer(config, offerId);
    if (!offer) return { status: 404, body: { error: 'unknown_offer', message: 'That offer is not available.' } };
    if (!offer.price || !config.stripe.secretKey) return { status: 503, body: { error: 'checkout_not_configured', message: "Checkout isn't connected yet." } };
    if (idempotencyKey) {
      const stored = db.prepare("SELECT status, body FROM idempotency WHERE account_id = ? AND route = 'checkout' AND key = ?").get(account.id, idempotencyKey) as Row | undefined;
      if (stored) return { status: Number(stored.status), body: JSON.parse(stored.body as string) };
    }
    const processorKey = 'arcane-' + createHash('sha256').update(account.id + ':' + offer.id + ':' + (idempotencyKey ?? randomUUID())).digest('hex').slice(0, 48);
    const session = await createCheckoutSession(config, offer, account, processorKey, deps.fetch);
    const body = { id: session.id, url: session.url };
    tx(db, () => {
      if (idempotencyKey) db.prepare("INSERT OR IGNORE INTO idempotency (account_id, route, key, status, body, created_at) VALUES (?, 'checkout', ?, 200, ?, ?)").run(account.id, idempotencyKey, JSON.stringify(body), now());
      audit(db, account.id, 'checkout.created', { offer: offer.id, session: session.id });
    });
    return { status: 200, body };
  }

  const accountRoutes=createAccountRoutes({config,db,now,providerFetch:deps.accountFetch,paymentFetch:deps.fetch,checkout:startCheckout});


  function checkoutPage(res: ServerResponse, url: URL): void {
    const offer = findOffer(config, url.searchParams.get('offer'));
    if (!offer || (url.searchParams.get('kind') && url.searchParams.get('kind') !== offer.kind)) return page(res, 404, 'Offer not found', '<p>That offer is not available. Return to Arcane and try again.</p>');
    page(res, 200, 'Arcane checkout', '<p>Enter the email you use (or will use) to sign in to Arcane. Your purchase is added to that account.</p>' +
      '<form method="post" action="/v1/checkout"><input type="hidden" name="offer" value="' + html(offer.id) + '">' +
      '<label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label><button type="submit">Continue to payment</button></form>');
  }

  async function checkoutRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      const account = requireAccount(req);
      const body = await readJson(req);
      const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;
      if (key !== null && !IDEMPOTENCY_KEY.test(key)) throw new HttpError(400, 'bad_idempotency_key', 'Idempotency-Key must be 8-128 URL-safe characters.');
      const result = await startCheckout(account, body.offer, key);
      return json(res, result.status, result.body);
    }
    // Browser form from GET /checkout: the purchase is credited to the account with that email (created if new).
    sameOrigin(req); ipLimit(req);
    const form = await readForm(req);
    const email = normalizeEmail(form.get('email'));
    if (!email || !OFFER_ID.test(form.get('offer') ?? '')) return page(res, 400, 'Check your details', '<p>Enter a valid email address and try again.</p>');
    const account = tx(db, () => {
      let found = accountByEmail(db, email);
      if (!found) {
        const id = 'acct_' + randomUUID().replace(/-/g, '');
        db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(id, email, now());
        audit(db, id, 'account.created', { via: 'checkout' });
        found = accountByEmail(db, email);
      }
      return found as Account;
    });
    const result = await startCheckout(account, form.get('offer'), null);
    if (result.status !== 200 || !('url' in result.body)) return page(res, result.status, "Checkout isn't available", '<p>' + html('message' in result.body ? result.body.message : 'Try again later.') + ' Nothing was charged.</p>');
    res.writeHead(303, { Location: result.body.url }); res.end();
  }

  // ---- webhook ---------------------------------------------------------------------------------------------------
  async function webhookRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, config.limits.maxWebhookBytes);
    try { verifyWebhookSignature(raw, req.headers['stripe-signature'] as string | undefined, config.stripe.webhookSecret, config.stripe.toleranceSeconds, Math.floor(now() / 1000)); }
    catch (error) {
      if (error instanceof SignatureError) { audit(db, null, 'webhook.rejected', { reason: error.message }); throw new HttpError(400, 'bad_signature', 'Signature verification failed.'); }
      throw error;
    }
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'Malformed event.'); }
    const data = event && typeof event === 'object' ? event.data as Record<string, unknown> | undefined : undefined;
    if (!data || typeof data.object !== 'object' || typeof event.id !== 'string' || typeof event.type !== 'string') throw new HttpError(400, 'bad_event', 'Malformed event.');
    const outcome = applyWebhookEvent(db, config, event, now());
    json(res, 200, { received: true, outcome });
  }

  // ---- auth ------------------------------------------------------------------------------------------------------
  function verifyPage(res: ServerResponse, code: string | null): void {
    page(res, 200, 'Sign in to Arcane', '<p>Check that this code matches the one Arcane shows, then enter your email. We will email you a sign-in link.</p>' +
      '<form method="post" action="/v1/auth/verify"><label>Code<input name="user_code" required maxlength="9" autocomplete="off" value="' + html(code ?? '') + '"></label>' +
      '<label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label><button type="submit">Email me a sign-in link</button></form>');
  }

  // ---- chat ------------------------------------------------------------------------------------------------------
  function readChat(body: Record<string, unknown>) {
    const model = config.models.find(entry => entry.id === body.model);
    if (!model) throw new HttpError(400, 'unknown_model', 'That model is not available.');
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 200) throw new HttpError(400, 'bad_messages', 'Send between 1 and 200 messages.');
    const clean: ChatMessage[] = messages.map(raw => {
      const row = raw as Record<string, unknown>;
      if (!row || !['user', 'assistant', 'system'].includes(row.role as string) || typeof row.content !== 'string' || row.content.length > 200000) throw new HttpError(400, 'bad_messages', 'Each message needs a role and text content.');
      return { role: row.role as ChatMessage['role'], content: row.content };
    });
    if (body.turnId !== undefined && (typeof body.turnId !== 'string' || !TURN_ID.test(body.turnId))) throw new HttpError(400, 'bad_turn', 'turnId is invalid.');
    if (body.maxTokens !== undefined && (!Number.isSafeInteger(body.maxTokens) || (body.maxTokens as number) < 1)) throw new HttpError(400, 'bad_max_tokens', 'maxTokens must be a positive integer.');
    const maxTokens = Math.min((body.maxTokens as number | undefined) ?? model.maxOutputTokens, model.maxOutputTokens);
    return { model, messages: clean, maxTokens, turnId: (body.turnId as string | undefined) ?? null };
  }

  async function chatRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const account = requireAccount(req);
    if (!accountRate.take(account.id, now())) throw new HttpError(429, 'rate_limited', 'Too many requests. Try again in a minute.');
    const release = streams.acquire(account.id);
    if (!release) throw new HttpError(429, 'too_many_streams', 'Too many chats are running at once on this account.');
    try {
      const { model, messages, maxTokens, turnId } = readChat(await readJson(req, config.limits.maxBodyBytes));
      const key = req.headers['idempotency-key'];
      if (key !== undefined) {
        if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) throw new HttpError(400, 'bad_idempotency_key', 'Idempotency-Key must be 8-128 URL-safe characters.');
        const inserted = db.prepare("INSERT OR IGNORE INTO idempotency (account_id, route, key, status, body, created_at) VALUES (?, 'chat', ?, 200, '{}', ?)").run(account.id, key, now());
        if (!Number(inserted.changes)) throw new HttpError(409, 'duplicate_request', 'This request was already sent.');
      }
      const estimatedInput = estimateInputTokens(messages);
      const required = creditsFor(model, estimatedInput, maxTokens, config.markupBps);
      const reservation = reserve(db, config, account.id, turnId, required, now());
      if (!reservation.ok) return json(res, 402, { error: 'insufficient_balance', message: 'You are out of Arcane Credits.', required: reservation.required, available: reservation.available });
      const hold = reservation.hold, requestId = randomUUID();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.limits.streamTimeoutMs);
      res.on('close', () => { if (!res.writableFinished) controller.abort(); });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const send = (event: unknown) => { if (!res.destroyed) res.write('data: ' + JSON.stringify(event) + '\n\n'); };
      let text = '', inputTokens: number | undefined, outputTokens: number | undefined, failed = false;
      try {
        for await (const event of deps.upstream(config, model, messages, maxTokens, controller.signal)) {
          if (event.type === 'delta') { text += event.text; send({ type: 'delta', text: event.text }); }
          else { inputTokens = event.inputTokens ?? inputTokens; outputTokens = event.outputTokens ?? outputTokens; }
        }
      } catch (error) {
        failed = true;
        log('chat upstream error: ' + (error instanceof Error ? error.message : 'unknown'));
      } finally { clearTimeout(timer); }
      const used = { inputTokens: inputTokens ?? (text ? estimatedInput : 0), outputTokens: outputTokens ?? estimateOutputTokens(text) };
      // A failed request that produced nothing is not charged.
      const actual = failed && !text ? 0 : creditsFor(model, used.inputTokens, used.outputTokens, config.markupBps);
      const charged = settle(db, hold, actual, { model: model.id, ...used, requestId }, now());
      if (failed) send({ type: 'error', message: controller.signal.aborted ? 'The request was stopped.' : 'The model is unavailable right now.' });
      else send({ type: 'done', creditsUsed: charged, actionsUsed: hold.actionConsumed ? 1 : 0 });
      res.end();
    } finally { release(); }
  }

  // ---- router ----------------------------------------------------------------------------------------------------
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    baseHeaders(res);
    if (cors(req, res)) return;
    const url = new URL(req.url ?? '/', config.publicOrigin);
    if(accountRoutes&&await accountRoutes(req,res,url))return;
    const key = (req.method ?? 'GET') + ' ' + url.pathname;
    switch (key) {
      case 'GET /v1/health': return json(res, 200, { service: 'arcane-billing', version: 1, gateway: true });
      case 'GET /v1/models': requireAccount(req); return json(res, 200, { models: config.models.map(model => ({ id: model.id, label: model.label })) });
      case 'GET /v1/balance': return json(res, 200, balanceOf(requireAccount(req)));
      case 'GET /v1/usage': return json(res, 200, usageOf(db, requireAccount(req).id, new Date(now())));
      case 'POST /v1/chat':
      case 'POST /v1/chat/stream': return chatRoute(req, res);
      case 'GET /checkout': return checkoutPage(res, url);
      case 'GET /checkout/done': return page(res, 200, 'Payment received', '<p>Thanks. Your balance updates in Arcane within a minute. You can close this tab.</p>');
      case 'GET /checkout/cancelled': return page(res, 200, 'Checkout cancelled', '<p>Nothing was charged. You can close this tab.</p>');
      case 'POST /v1/checkout': return checkoutRoute(req, res);
      case 'POST /v1/stripe/webhook': return webhookRoute(req, res);
      case 'POST /v1/auth/device': ipLimit(req); return json(res, 200, startDevice(db, config, now()));
      case 'GET /v1/auth/verify': return verifyPage(res, normalizeUserCode(url.searchParams.get('user_code')));
      case 'POST /v1/auth/verify': {
        sameOrigin(req); ipLimit(req);
        const form = await readForm(req);
        try { await requestLink(db, config, form.get('user_code'), form.get('email'), deps.sendMail, now()); }
        catch (error) { log('sign-in mail failed: ' + (error instanceof Error ? error.message : 'unknown')); }
        // Same answer whether or not the code or email was valid.
        return page(res, 200, 'Check your email', '<p>If the code is current, a sign-in link is on its way. It expires in 15 minutes.</p>');
      }
      case 'GET /v1/auth/confirm': {
        const token = url.searchParams.get('t') ?? '';
        const code = describeLink(db, config, token, now());
        if (!code) return page(res, 410, 'Link expired', '<p>This sign-in link was already used or has expired. Start again from Arcane.</p>');
        return page(res, 200, 'Approve sign-in', '<p>Approve signing in to Arcane on the device showing this code:</p><p><code>' + html(code) + '</code></p>' +
          '<form method="post" action="/v1/auth/confirm"><input type="hidden" name="t" value="' + html(token) + '"><button type="submit">Approve</button></form><p>If the code does not match, close this page.</p>');
      }
      case 'POST /v1/auth/confirm': {
        sameOrigin(req); ipLimit(req);
        const ok = confirmLink(db, config, (await readForm(req)).get('t'), now());
        return ok ? page(res, 200, 'Signed in', '<p>Return to Arcane. It finishes signing in on its own.</p>') : page(res, 410, 'Link expired', '<p>This sign-in link was already used or has expired.</p>');
      }
      case 'POST /v1/auth/token': {
        ipLimit(req);
        const result = pollToken(db, config, (await readJson(req)).deviceCode, now());
        return 'token' in result ? json(res, 200, { token: result.token, tokenType: 'Bearer' }) : json(res, 400, { error: result.error });
      }
      case 'POST /v1/auth/logout': {
        const ok = revoke(db, config, req.headers.authorization, now());
        return ok ? json(res, 200, { signedOut: true }) : json(res, 401, { error: 'unauthorized', message: 'Sign in to your Arcane account.' });
      }
      default: throw new HttpError(404, 'not_found', 'Not found.');
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try { await route(req, res); }
    catch (error) {
      const known = error instanceof HttpError;
      if (!known) log('gateway error: ' + (error instanceof Error ? error.message : 'unknown'));
      if (res.headersSent) { res.destroy(); return; }
      json(res, known ? error.status : 500, { error: known ? error.code : 'internal', message: known ? error.message : 'Something went wrong.' },
        known && error.status === 429 ? { 'Retry-After': '60' } : {});
    }
  }

  const sweeper = setInterval(() => { try { sweepAuth(db, now()); db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(now() - 86_400_000); } catch { /* next run */ } }, 3600_000);
  sweeper.unref();
  return { handle, close: () => clearInterval(sweeper), streams };
}

export function createGatewayServer(deps: GatewayDeps): { server: Server; close: () => void } {
  const gateway = createGateway(deps);
  // requestTimeout bounds receiving the request (slow uploads); streamed replies are bounded by STREAM_TIMEOUT_MS.
  const server = createServer({ requestTimeout: 60_000, headersTimeout: 15_000, keepAliveTimeout: 5_000 }, (req, res) => { void gateway.handle(req, res); });
  return { server, close: () => { gateway.close(); server.close(); } };
}
