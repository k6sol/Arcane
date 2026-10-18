# Arcane gateway (reference)

One small service that does what the Arcane desktop app expects from your infrastructure:

- **Billing.** Hosted checkout for plans, action packs and credits. A verified payment webhook grants each purchase once.
- **Accounts.** Verified email/password, Google or Apple sign-in through Supabase Auth; optional authenticator
  two-step verification; persistent encrypted browser sessions and device-code approval for the app.
- **Administration.** A server-authorized owner panel for account status, balances, recent activity and member session
  revocation. Owner access requires an authenticator and a recent second-factor check.
- **Model gateway.** Streams chat from upstream model providers with your server-side API keys. Tokens are metered to
  credits with your price table and markup. A request the balance can't cover is refused.

It uses Node 24 built-ins only (`node:http`, `node:sqlite`, `fetch`). There is nothing to `npm install`, and Node runs
the TypeScript sources directly. The API contract is in [`docs/ARCANE_CREDITS.md`](../../docs/ARCANE_CREDITS.md).

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/health` | none | `{"service":"arcane-billing","version":1,"gateway":true}` |
| GET | `/account` | browser session | Registration, login, security settings, device approval and billing |
| GET | `/admin` | owner + recent MFA | Account administration |
| GET | `/checkout?kind=&offer=` | browser | Continue in the authenticated account page |
| POST | `/v1/account/checkout` | browser session + CSRF + enrolled MFA | Hosted Checkout for the signed-in account |
| POST | `/v1/account/billing-portal` | browser session + CSRF + enrolled MFA | Own subscription and invoices |
| POST | `/v1/checkout` | managed bearer JSON | Create a Checkout Session from the server price map |
| POST | `/v1/stripe/webhook` | processor signature | Verify, then grant idempotently |
| POST | `/v1/auth/device` | none | Start sign-in: `deviceCode`, `userCode`, `verificationUrl` |
| GET | `/v1/auth/verify?user_code=` | browser | Continue in `/account` to approve the app's code |
| POST | `/v1/account/approve-device` | browser session + CSRF + enrolled MFA | Approve only the signed-in account |
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
  - production without managed authentication or an exact public origin.
- **Managed sessions and MFA.** The browser receives an HttpOnly cookie, never provider access or refresh tokens.
  AES-256-GCM protects session payloads and managed identity email fields. Session IDs are stored as keyed hashes.
  An enrolled authenticator is enforced on the server; owner administration requires a check within 15 minutes.
  See [the account security model](../../docs/build/ACCOUNT_SECURITY.md) for storage, session and verification boundaries.
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
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Exact Auth project origin and publishable key; never a service-role key |
| `ACCOUNTS_SESSION_KEY` | Separate 32 random bytes encoded as base64url; preserve across deployments |
| `ADMIN_BOOTSTRAP_EMAIL` | Private verified owner email; one-time owner bootstrap after authenticator verification |
| `ACCOUNT_SOCIAL_PROVIDERS` | Registered `google,apple` providers; empty for email/password only |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Your payment processor's API key and webhook signing secret |
| `STRIPE_PRICE_<OFFER>` | One price id per offer id in `packages/protocol/src/plans.ts`. Plans need recurring monthly prices. Packs and credits need one-time prices. |
| `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` | Server-side upstream keys, under terms that allow relaying access |
| `MODELS_JSON` | The models you offer: `id`, `label`, `provider` (`anthropic` or `openai`), `upstream` model id, `inputPerMTok`, `outputPerMTok` (credits per 1M tokens before markup), `maxOutputTokens` |
| `MARKUP_BPS`, `ACTION_CREDIT_ALLOWANCE` | Markup (`12000` = +20 %), and how much usage one plan/pack action covers in one turn |
| Supabase email configuration | Production SMTP and required email confirmation; `MAIL_MODE=off` with managed accounts |

With the default offers, 1 credit is worth 1 cent (`credits-10` grants 1000). Set `inputPerMTok` and `outputPerMTok`
from your provider's current price sheet, in the same unit.

Set Supabase's site URL to `PUBLIC_URL`, allow the `/account/callback` URL and its flow query parameter, enable TOTP,
and register Google and Apple before listing them in `ACCOUNT_SOCIAL_PROVIDERS`. Open `/account`, sign in with the
private owner email, and verify an authenticator to enable `/admin`. Store keys and the owner email in the host's
secret manager or an ignored local environment file. Keep the database and both encryption/hash keys across updates.

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
5. With managed accounts configured, open `/account`, sign in and choose a configured test offer.
6. Complete hosted Checkout with a test card and verify its signed webhook before checking the balance in Arcane.
   Creating a Checkout Session alone does not grant credit.

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
6. Validate real-domain email verification, password recovery, Google/Apple callbacks, authenticator checks, device
   approval, administration, payment webhooks and the customer portal in test mode. Approve actual prices before
   switching to live keys and live price IDs or setting `placeholderPrices: false`.

The reference runs as a **single instance**. Rate limits and concurrency caps are in memory, and SQLite is a local
file. To scale out, move those limits and the database to shared stores.

Not covered by the reference:

- Refunds and chargebacks: handle them in the processor dashboard and adjust balances by hand. The `grants` table shows
  what each purchase gave.
- Email delivery and authenticated account recovery: configure and test them with Supabase before launch.
- Taxes and invoices: configure them in the processor.
