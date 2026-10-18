# Arcane gateway (reference)

One small service that does what the Arcane desktop app expects from your infrastructure:

- **Billing.** Hosted checkout for plans, action packs and credits. A verified payment webhook grants each purchase once.
- **Accounts.** Device-code sign-in confirmed by an emailed link. The app gets an opaque bearer token. Only keyed hashes
  are stored.
- **Model gateway.** Streams chat from upstream model providers with your server-side API keys. Tokens are metered to
  credits with your price table and markup. A request the balance can't cover is refused.

It uses Node 24 built-ins only (`node:http`, `node:sqlite`, `fetch`). There is nothing to `npm install`, and Node runs
the TypeScript sources directly. The API contract is in [`docs/ARCANE_CREDITS.md`](../../docs/ARCANE_CREDITS.md).

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/health` | none | `{"service":"arcane-billing","version":1,"gateway":true}` |
| GET | `/checkout?kind=&offer=` | none | Checkout page (email of the account to credit) |
| POST | `/v1/checkout` | form (same origin) or bearer JSON | Create a Checkout Session from the server price map, then `303` or `{id,url}` |
| POST | `/v1/stripe/webhook` | processor signature | Verify, then grant idempotently |
| POST | `/v1/auth/device` | none | Start sign-in: `deviceCode`, `userCode`, `verificationUrl` |
| GET/POST | `/v1/auth/verify` | browser | Enter code and email; a link is emailed |
| GET/POST | `/v1/auth/confirm` | browser | Approve from the emailed link |
| POST | `/v1/auth/token` | none | Poll with `deviceCode`; returns the bearer token once |
| POST | `/v1/auth/logout` | bearer | Revoke the token |
| GET | `/v1/balance` | bearer | `{credits, actionsRemaining, plan, renewsAt}` |
| GET | `/v1/usage` | bearer | `{period, creditsUsed, actionsUsed}` for the current UTC month |
| GET | `/v1/models` | bearer | Models from `MODELS_JSON` (ids and labels only) |
| POST | `/v1/chat/stream` (alias `/v1/chat`) | bearer | Streaming chat (SSE): `delta` events, then `done {creditsUsed, actionsUsed}` or `error` |

## Security

- **No secrets in code.** Every key comes from the environment, and config validation refuses unsafe combinations:
  - a short `AUTH_SECRET`;
  - plain http in production;
  - live payment keys outside production;
  - printing sign-in links (`MAIL_MODE=log`) in production;
  - mock models in production.
- **Tokens.** Bearer tokens (`arc_` + 256 random bits), device codes and sign-in links are stored only as
  HMAC-SHA256 hashes keyed with `AUTH_SECRET`. Links are single use, expire in 15 minutes, and approve only through a
  POST button that shows the code again. Device codes expire in 10 minutes, and polling is throttled (`slow_down`).
- **CORS** is closed by default. The desktop app calls from its host process and needs none. `CORS_ORIGINS` admits
  exact https origins only.
- **Bounded input.**
  - Bodies: 16 KiB for JSON and forms, 512 KiB for webhooks, `MAX_CHAT_BODY_BYTES` for chat.
  - Upstream streams: capped at 16 MiB, with `STREAM_TIMEOUT_MS`.
  - Requests: request and header timeouts.
- **Webhooks.**
  - The signature is HMAC-SHA256 over `t.payload`, compared in constant time, with multiple `v1` signatures allowed
    during secret rotation.
  - Replay protection: timestamps older than the tolerance are refused, and each event id is recorded once.
  - Each grant has its own key, so a re-sent event under a new id still grants once.
  - Grants use only the server-side catalog; client-provided amounts are never trusted.
- **Idempotency keys.**
  - `POST /v1/checkout` with the same `Idempotency-Key` returns the same session. The processor also receives a derived
    idempotency key.
  - `POST /v1/chat/stream` refuses a reused key with `409`.
- **Limits.**
  - Per-account rate limit: `RATE_LIMIT_PER_MINUTE`.
  - Per-account concurrent streams: `MAX_CONCURRENT_STREAMS`.
  - Per-IP limit on sign-in and checkout form posts.
- **CSRF.** Browser form posts must come from the gateway's own origin. Pages send a strict CSP and `frame-ancestors 'none'`.
- **Audit log.** The `audit` table records:
  - sign-in links sent (email hashed), account creation, device approval, token issue;
  - checkout sessions, grants and rejected webhooks;
  - every chat charge, balance refusal and estimate overrun.
- **Money safety.** Each balance change runs in one SQLite `BEGIN IMMEDIATE` transaction. `CHECK` constraints keep
  balances at zero or above.

## Configure

Copy `.env.example` and fill it in. Never commit the filled-in file. The keys you must provide:

| Variable | What |
| --- | --- |
| `PUBLIC_URL` | The https URL people reach the gateway at |
| `AUTH_SECRET` | 32+ random characters |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Your payment processor's API key and webhook signing secret |
| `STRIPE_PRICE_<OFFER>` | One price id per offer id in `packages/protocol/src/plans.ts`. Plans need recurring monthly prices. Packs and credits need one-time prices. |
| `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` | Server-side upstream keys, under terms that allow relaying access |
| `MODELS_JSON` | The models you offer: `id`, `label`, `provider` (`anthropic` or `openai`), `upstream` model id, `inputPerMTok`, `outputPerMTok` (credits per 1M tokens before markup), `maxOutputTokens` |
| `MARKUP_BPS`, `ACTION_CREDIT_ALLOWANCE` | Markup (`12000` = +20 %), and how much usage one plan/pack action covers in one turn |
| `MAIL_MODE=webhook`, `MAIL_WEBHOOK_URL` | Where sign-in emails go: JSON `{from,to,subject,text}`, signed with `MAIL_WEBHOOK_SECRET` |

With the default offers, 1 credit is worth 1 cent (`credits-10` grants 1000). Set `inputPerMTok` and `outputPerMTok`
from your provider's current price sheet, in the same unit.

## Run locally (test mode)

```sh
cd services/gateway
npm test                       # node:test, mocked processor and providers, no network
PUBLIC_URL=http://127.0.0.1:8787 AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  MAIL_MODE=log DATABASE_FILE=./data/dev.sqlite \
  MODELS_JSON='[{"id":"arcane-default","label":"Arcane default","provider":"mock","upstream":"echo","inputPerMTok":300,"outputPerMTok":1500}]' \
  npm start
```

`provider: "mock"` echoes text without any upstream call. It is for development only and refused in production.

Test-mode payments:

1. In your payment processor dashboard, switch to **test mode**.
2. Create test products and prices for the offers you sell. Use recurring monthly prices for plans and one-time prices
   for packs and credits. Put each price id in `STRIPE_PRICE_<OFFER>`.
3. Set `STRIPE_SECRET_KEY=sk_test_…`.
4. Forward webhooks to your local server with the processor's CLI (`stripe listen --forward-to
   localhost:8787/v1/stripe/webhook`), and set `STRIPE_WEBHOOK_SECRET` to the `whsec_…` it prints.
5. Open `http://127.0.0.1:8787/checkout?kind=credits&offer=credits-10` and pay with a test card.
6. Sign in with the same email. `GET /v1/balance` then shows the credits.

## Deploy (any container host)

```sh
docker build -t arcane-gateway services/gateway
docker run -d --name arcane-gateway -p 8787:8787 --env-file /secure/arcane-gateway.env \
  -v arcane-gateway-data:/data --restart unless-stopped arcane-gateway
```

Without Docker, run on any host with Node 24 or later: `NODE_ENV=production node --disable-warning=ExperimentalWarning
src/main.ts` under a process supervisor.

1. Put it behind an https reverse proxy or load balancer for your domain, and set `TRUST_PROXY=1`. Allow long-lived
   responses for `/v1/chat/stream`, with proxy buffering off.
2. Mount a persistent volume at `/data` and back up `gateway.sqlite`. It holds balances.
3. In the processor dashboard, add a webhook endpoint `https://<your gateway>/v1/stripe/webhook` with these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `invoice.paid`
   - `customer.subscription.deleted`

   Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Check `GET https://<your gateway>/v1/health`.
5. Point the app at it in `packages/protocol/src/plans.ts`, then rebuild:

   ```ts
   billing: { serviceUrl: 'https://gateway.your-domain.example', allowedOrigins: ['https://gateway.your-domain.example'] },
   gateway: { url: 'https://gateway.your-domain.example', allowedOrigins: ['https://gateway.your-domain.example'] },
   ```

   Settings > Plans & credits then shows "Checkout connected" and **Connect Arcane account**.
6. Go live: switch to live keys and live price ids, and set `placeholderPrices: false` once real prices are entered.

The reference runs as a **single instance**. Rate limits and concurrency caps are in memory, and SQLite is a local
file. To scale out, move those limits and the database to shared stores.

Not covered by the reference:

- Refunds and chargebacks: handle them in the processor dashboard and adjust balances by hand. The `grants` table shows
  what each purchase gave.
- Email delivery: bring your own mail service behind `MAIL_WEBHOOK_URL`.
- Taxes and invoices: configure them in the processor.
